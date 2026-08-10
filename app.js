import express from 'express';
import expressWs from 'express-ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { logger, createLogger } from './logger/index.js';
import { connectRedis, getRedis, getRedisBudget } from './storage/redis.js';
import { initAuth, exchangeCodeForToken, isAuthorized } from './twitch/auth.js';
import { DeepSeekClient } from './ai/client.js';
import { buildUserPrompt } from './ai/prompt.js';
import { builtins, loadCustomCommands, saveCustomCommand, deleteCustomCommand } from './commands/index.js';
import './commands/builtins.js';
import { Moderation } from './moderation/index.js';
import { CooldownManager } from './utils/cooldown.js';
import { initializeEmotes, getRandomEmote, setEmotePools } from './twitch/emotes.js';
import { shouldRespond, getFallbackResponse } from '../personality.js';
import { metrics as promMetrics, getMetrics } from './utils/metrics.js';
import { getBrain } from './brains/index.js';
import { scoreBrains } from './brains/router.js';
import { enqueueTask, startWorker, drainQueues } from './queue/index.js';
import { jobHandlers } from './queue/handlers.js';
import bus from './bus/index.js';
import { loadPlugins } from './plugins/index.js';
import { ConversationStore } from './memory/conversationStore.js';
import { ProfileStore } from './memory/profileStore.js';
import { MessageQueue } from './queue/messageQueue.js';
import { EventSubClient } from './twitch/eventsub.js';
import { PollinationsClient } from './media/providers.js';
import { writeFile } from 'fs/promises';

const log = createLogger('APP');
const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', config.server.trustProxy || 1);

let botInitialized = false;
let deepseek = null;
let moderation = null;
let cooldown = new CooldownManager(config.cooldown);
let customCommands = new Map();
let wsClients = new Set();
let server = null;
let workers = [];
let heartbeatInterval = null;
let messageQueue = null;
let eventSubClient = null;
let pollinations = new PollinationsClient();
const publicUrl = config.server.publicUrl || 'http://localhost:3000';

const AUTO_ENABLED = config.auto.enabled;
const AUTO_INTERVAL = config.auto.interval * 1000;
const AUTO_USE_DEEPSEEK = config.auto.useDeepSeek;
const AUTO_QUIET_THRESHOLD = config.auto.quietThreshold * 1000;
const AUTO_WELCOME = config.auto.welcome;
const FALLBACK_MESSAGES = [
  "Just vibing in the chat! How's everyone doing?",
  "Anyone else hyped for the next game?",
  "I'm SweatyClanker, your friendly neighborhood bot!",
  "Don't forget to follow if you're enjoying the stream!",
  "What's your favourite game right now?",
  "I'm learning new things every day – thanks for chatting with me!",
  "Feeling lucky today – who's ready for some PogChamp moments?",
];
let fallbackIndex = 0;

app.use(helmet());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, validate: false });
app.use(limiter);
const allowedOrigins = config.server.allowedOrigins || [];
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use('/public', express.static('public'));

app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => wsClients.delete(ws));
});
heartbeatInterval = setInterval(() => {
  for (const ws of wsClients) {
    if (!ws.isAlive) { ws.terminate(); wsClients.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcast(data) {
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  }
}

app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/livez', (req, res) => res.status(200).send('OK'));
app.get('/api/redis-budget', (req, res) => res.json(getRedisBudget()));
app.post('/api/jobs/:type', async (req, res) => {
  const type = String(req.params.type || '');
  if (!config.workers.enabled) return res.status(503).json({ error: 'Workers are disabled' });
  if (!config.workers.apiKey) return res.status(503).json({ error: 'WORKER_API_KEY is not configured' });
  if (req.get('x-worker-key') !== config.workers.apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (!jobHandlers[type]) return res.status(404).json({ error: 'Unknown worker type' });
  try {
    const job = await enqueueTask(type, req.body || {}, req.body?.jobId ? { jobId: String(req.body.jobId) } : {});
    res.status(202).json({ accepted: true, type, jobId: job.id });
  } catch (err) {
    log.error(`Failed to enqueue ${type}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});
app.get('/readyz', async (req, res) => {
  let attempts = 0;
  while (attempts < 20) {
    const twitchReady = !!global.twitchClient?.connected;
    const redisReady = !!getRedis();
    const deepseekReady = !!deepseek;
    const authReady = isAuthorized();
    if (twitchReady && redisReady && deepseekReady && authReady) {
      return res.status(200).json({ status: 'ready' });
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }
  res.status(503).json({
    redis: !!getRedis(),
    twitch: global.twitchClient?.connected || false,
    deepseek: !!deepseek,
    auth: isAuthorized(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(await getMetrics());
});

app.get('/auth/login', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${config.twitch.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read chat:edit user:bot user:read:chat user:write:chat moderation:read channel:manage:moderators moderator:read:followers moderator:manage:shoutouts`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
    await exchangeCodeForToken(code, redirectUri);
    if (!botInitialized) await initializeBot();
    else log.info('Bot already running, skipping re‑initialization');
    res.send('Authorization successful! You may close this window.');
  } catch (err) {
    log.error('Auth callback failed', err);
    res.status(500).send('Authorization failed');
  }
});

app.post('/api/commands', async (req, res) => {
  const { name, response, role } = req.body;
  if (!name || !response) return res.status(400).json({ error: 'Missing fields' });
  await saveCustomCommand(name, response, role || 'all');
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.delete('/api/commands/:name', async (req, res) => {
  await deleteCustomCommand(req.params.name);
  await loadCustomCommandsIntoMemory();
  res.json({ success: true });
});

app.post('/api/media/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await pollinations.generateImage(prompt);
    const filename = `image-${Date.now()}.png`;
    await writeFile(`public/${filename}`, result.buffer);
    const url = `${publicUrl}/public/${filename}`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function generateSpontaneousMessage(channel) {
  if (!deepseek || !AUTO_USE_DEEPSEEK) {
    const msg = FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
    fallbackIndex++;
    return msg;
  }
  const systemPrompt = `You are SweatyClanker, a Twitch chatter. Say something spontaneous, fun, and engaging to the chat. Keep it short.`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Say something random to the chat.' }
  ];
  try {
    const start = Date.now();
    const reply = await deepseek.chat(messages, { temperature: 0.9 });
    promMetrics.aiLatency.observe((Date.now() - start) / 1000);
    promMetrics.aiCalls.inc();
    return reply;
  } catch (err) {
    log.error('Failed to generate spontaneous message', err);
    promMetrics.aiErrors.inc();
    return FALLBACK_MESSAGES[fallbackIndex % FALLBACK_MESSAGES.length];
  }
}

function startAutoMessages() {
  if (!AUTO_ENABLED) return;
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  global._autoMessageTimer = setInterval(async () => {
    const twitchClient = global.twitchClient;
    if (!twitchClient || !twitchClient.connected) return;
    const now = Date.now();
    for (const channel of twitchClient.channels) {
      const last = await ConversationStore.getLastActivity(channel);
      if (now - last < AUTO_QUIET_THRESHOLD) continue;
      const msg = await generateSpontaneousMessage(channel);
      if (!msg) continue;
      let finalMsg = msg;
      if (config.emotes.enable) {
        const emote = getRandomEmote(channel);
        if (emote) finalMsg += ` ${emote}`;
      }
      if (messageQueue) messageQueue.enqueue(channel, finalMsg);
      else await twitchClient.say(channel, finalMsg);
      promMetrics.messagesSent.inc();
      await ConversationStore.pushMessage(channel, 'bot', finalMsg);
    }
  }, AUTO_INTERVAL);
  log.info(`Auto‑messages started (interval: ${AUTO_INTERVAL/1000}s)`);
}

async function loadCustomCommandsIntoMemory() {
  customCommands = await loadCustomCommands();
}

// ========== HANDLE MESSAGE ==========
async function handleMessage({ channel, user, message, self }) {
  if (self) return;
  promMetrics.messagesReceived.inc();
  const username = user['display-name'] || user.username;
  const login = user.username.toLowerCase();
  log.info(`📩 IN: ${username} @ ${channel}: ${message}`);
  await ConversationStore.updateLastActivity(channel);
  if (config.twitch.ignoredUsers.includes(login)) return;
  const modResult = moderation.analyze(channel, user, message);
  if (modResult.blocked) {
    log.warn(`Blocked message from ${username} in ${channel}`);
    enqueueTask('moderation-review', { channel, user: username, message, reason: 'rule_blocked' });
    return;
  }
  if (modResult.riskScore > 40) {
    enqueueTask('moderation-review', { channel, user: username, message, riskScore: modResult.riskScore });
  }
  const lowerMsg = message.trim().toLowerCase();
  // Custom commands
  const cmdKey = [...customCommands.keys()].find(cmd => lowerMsg === cmd || lowerMsg.startsWith(cmd + ' '));
  if (cmdKey) {
    log.info(`🔧 Custom command matched: ${cmdKey}`);
    const cmd = customCommands.get(cmdKey);
    const hasPermission = cmd.role === 'all' ||
      (cmd.role === 'moderator' && (user.mod || user.badges?.broadcaster)) ||
      (cmd.role === 'broadcaster' && user.badges?.broadcaster);
    if (hasPermission) {
      const cooldownKey = `${channel}:${login}`;
      if (!cooldown.check(cooldownKey)) {
        log.debug(`Cooldown active for ${username} in ${channel}`);
        return;
      }
      const response = typeof cmd.response === 'function' ? cmd.response(message, user) : cmd.response;
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
      return;
    }
  }
  // Builtin commands
  const builtinKey = lowerMsg.split(' ')[0];
  if (builtins.has(builtinKey)) {
    log.info(`⚡ Built-in command matched: ${builtinKey}`);
    const cmd = builtins.get(builtinKey);
    const cooldownKey = `${channel}:${login}`;
    if (!cooldown.check(cooldownKey)) return;
    const response = await cmd.handler(user, channel, global.twitchClient, message);
    if (response) {
      if (messageQueue) messageQueue.enqueue(channel, response);
      else await global.twitchClient.say(channel, response);
      promMetrics.messagesSent.inc();
    }
    return;
  }
  // Media commands
  const mediaCommands = {
    [config.media.imageCommand]: { type: 'image', handler: pollinations.generateImage.bind(pollinations) },
    [config.media.videoCommand]: { type: 'video', handler: pollinations.generateVideo.bind(pollinations) },
    [config.media.ttsCommand]: { type: 'tts', handler: pollinations.generateAudio.bind(pollinations) },
    [config.media.musicCommand]: { type: 'music', handler: pollinations.generateMusic.bind(pollinations) },
  };
  for (const [cmd, { type, handler }] of Object.entries(mediaCommands)) {
    if (lowerMsg.startsWith(cmd)) {
      log.info(`🎨 Media command matched: ${cmd}`);
      const prompt = message.slice(cmd.length).trim();
      if (!prompt) {
        const response = `Usage: ${cmd} <description>`;
        const cooldownKey = `${channel}:${login}`;
        if (!cooldown.check(cooldownKey)) return;
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        return;
      }
      const cooldownKey = `${channel}:${login}`;
      if (!cooldown.check(cooldownKey)) return;
      try {
        const result = await handler(prompt);
        const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3';
        const filename = `media-${Date.now()}.${ext}`;
        await writeFile(`public/${filename}`, result.buffer);
        const url = `${publicUrl}/public/${filename}`;
        const response = `Here's your ${type}: ${url}`;
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
        promMetrics.messagesSent.inc();
      } catch (err) {
        log.error('Media generation failed', err);
        const response = 'Sorry, media generation failed.';
        if (messageQueue) messageQueue.enqueue(channel, response);
        else await global.twitchClient.say(channel, response);
      }
      return;
    }
  }
  // AI chat – FIX: use personaNames array
  const personaNames = [config.twitch.username.toLowerCase(), 'clanker', 'sweaty clanker'];
  const shouldReply = shouldRespond(message, personaNames);
  if (!shouldReply) {
    log.debug(`Skipping AI: no mention/greeting`);
    return;
  }
  const cooldownKey = `${channel}:${login}`;
  if (!cooldown.check(cooldownKey)) return;
  const brainName = await scoreBrains(channel, user, message);
  const Brain = getBrain(brainName);
  const brainConfig = Brain.getConfig();
  const history = await ConversationStore.getHistory(channel, config.deepseek.maxHistory);
  const systemPrompt = brainConfig.systemPrompt;
  const temperature = brainConfig.temperature || 0.7;
  const maxTokens = brainConfig.maxTokens || 1024;
  const userPrompt = buildUserPrompt(message, username, history);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userPrompt },
  ];
  try {
    log.info(`🤖 Sending to DeepSeek (brain: ${brainName})`);
    const start = Date.now();
    const reply = await deepseek.chat(messages, { temperature, maxTokens });
    const latency = Date.now() - start;
    promMetrics.aiLatency.observe(latency / 1000);
    promMetrics.aiCalls.inc();
    promMetrics.tokenUsage.inc(Math.ceil((userPrompt.length + systemPrompt.length) / 4));
    const processedReply = await Brain.processResponse(reply, { channel, user, message });
    if (brainName === 'moderation') {
      if (processedReply.toxic) {
        log.warn(`Toxicity detected from ${username}: ${processedReply.reason}`);
        enqueueTask('moderation-review', { channel, user: username, message, reason: processedReply.reason });
      }
      return;
    }
    let finalReply = processedReply || reply;
    if (!finalReply.trim()) finalReply = getFallbackResponse();
    await ConversationStore.pushMessage(channel, 'user', message, username);
    await ConversationStore.pushMessage(channel, 'assistant', finalReply);
    await ProfileStore.update(channel, login, { lastSeen: Date.now() });
    if (config.emotes.enable) {
      const emote = getRandomEmote(channel);
      if (emote) finalReply += ` ${emote}`;
    }
    if (messageQueue) messageQueue.enqueue(channel, finalReply);
    else await global.twitchClient.say(channel, finalReply);
    promMetrics.messagesSent.inc();
  } catch (err) {
    log.error('AI chat error', err);
    promMetrics.aiErrors.inc();
    const fallback = getFallbackResponse();
    if (messageQueue) messageQueue.enqueue(channel, fallback);
    else await global.twitchClient.say(channel, fallback);
    promMetrics.messagesSent.inc();
  }
}

// ========== JOIN HANDLER (FIXED: no bot/streamer spam) ==========
async function handleJoin({ channel, username, self }) {
  if (self) return;

  const broadcasterName = channel.replace('#', '').toLowerCase();
  const ignoredUsers = [
    broadcasterName,
    'streamelements', 'nightbot', 'overlayexpert', 'moobot', 'fossabot',
    'wizebot', 'coebot', 'phantombot', 'streamlabs', 'pretzelrocks',
    'sweatyclanker', 'anotherttvviewer', 'soundalerts', 'botrixoficial'
  ];

  if (ignoredUsers.includes(username.toLowerCase())) return;

  const key = `${channel}:${username}`;
  if (global._welcomedUsers && global._welcomedUsers.has(key)) return;
  if (!global._welcomedUsers) global._welcomedUsers = new Set();

  const history = await ConversationStore.getHistory(channel, 20);
  const hasSpoken = history.some(h => h.username === username);
  if (hasSpoken) return;

  const welcomeMsg = `Welcome to the stream, @${username}! Hope you enjoy the chaos.`;
  if (messageQueue) messageQueue.enqueue(channel, welcomeMsg);
  else await global.twitchClient.say(channel, welcomeMsg);
  promMetrics.messagesSent.inc();

  global._welcomedUsers.add(key);
  if (global._welcomedUsers.size > 2000) {
    log.debug('Clearing welcomed users cache (size > 2000)');
    global._welcomedUsers.clear();
  }
}

async function handleUserNotice({ channel, user, msg, tags }) {
  if (tags['msg-id'] === 'raid') {
    const from = tags['display-name'] || 'someone';
    const reply = `Thanks for the raid, ${from}! PogChamp`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
  } else if (tags['msg-id'] === 'sub' || tags['msg-id'] === 'resub') {
    const subName = tags['display-name'] || 'a viewer';
    const reply = `Thanks for the sub, ${subName}! Much love <3`;
    if (messageQueue) messageQueue.enqueue(channel, reply);
    else await global.twitchClient.say(channel, reply);
  }
}

async function handleClearChat({ channel }) {
  log.info(`Chat cleared in ${channel}`);
}

app.get('/', (req, res) => {
  res.send(`<h1>SweatyClanker Bot</h1><p>Status: Running</p><p><a href="/auth/login">Authorize on Twitch</a></p>`);
});

// ========== INITIALIZATION ==========
async function initializeBot() {
  if (botInitialized) {
    log.warn('Bot already initialized, skipping duplicate call');
    return;
  }
  botInitialized = true;
  log.info('Starting bot initialization...');
  if (!isAuthorized()) {
    log.warn('No valid token; bot not starting');
    return;
  }
  log.info('Initializing DeepSeek client...');
  deepseek = new DeepSeekClient();
  log.info('DeepSeek client ready');
  log.info('Initializing moderation...');
  moderation = new Moderation(config.moderation);
  log.info('Loading custom commands...');
  await loadCustomCommandsIntoMemory();
  const queueNames = Object.keys(jobHandlers);
  if (config.workers.enabled) {
    log.info('Starting low-usage BullMQ worker...');
    for (const q of queueNames) startWorker(q, jobHandlers[q], config.workers.concurrency);
    log.info(`Task handlers registered for: ${queueNames.join(', ')}`);
  } else {
    log.warn('Automation workers disabled by WORKERS_ENABLED=false');
  }

  // Register bus listeners before plugins
  bus.on('twitch.message', async (...args) => {
    log.info('🔊 BUS: twitch.message event received');
    try { await handleMessage(...args); } catch (err) { log.error('Error in handleMessage', err); }
  });
  bus.on('twitch.usernotice', async (...args) => {
    try { await handleUserNotice(...args); } catch (err) { log.error('Error in handleUserNotice', err); }
  });
  bus.on('twitch.clearchat', async (...args) => {
    try { await handleClearChat(...args); } catch (err) { log.error('Error in handleClearChat', err); }
  });
  bus.on('twitch.send', ({ channel, message }) => {
    try {
      if (messageQueue) messageQueue.enqueue(channel, message);
      else twitchClient?.say(channel, message);
    } catch (err) { log.error('Error in twitch.send handler', err); }
  });
  if (AUTO_WELCOME) {
    bus.on('twitch.join', async (...args) => {
      try { await handleJoin(...args); } catch (err) { log.error('Error in handleJoin', err); }
    });
  }

  // Load plugins
  log.info('Loading plugins...');
  await loadPlugins(bus, config);

  const twitchClient = global.twitchClient;
  if (twitchClient) {
    log.info('Initializing message queue...');
    messageQueue = new MessageQueue(twitchClient);
    log.info('Message queue initialized');
  }

  if (config.eventsub.secret) {
    try {
      log.info('Connecting to EventSub...');
      eventSubClient = new EventSubClient();
      await eventSubClient.connect();
      log.info('EventSub client connected');
    } catch (err) {
      log.warn('EventSub unavailable. Continuing without EventSub.', err.message);
    }
  } else {
    log.info('EventSub secret not set – skipping EventSub');
  }

  bus.on('twitch.ready', () => {
    log.info('Twitch client is ready. Starting auto-messages...');
    startAutoMessages();
  });

  log.info('Bot initialization complete');
  broadcast({ type: 'ready' });
}

// ========== BOOTSTRAP ==========
async function bootstrap() {
  log.info('🚀 Starting SweatyClanker v3...');
  log.info('🔌 Connecting to Redis...');
  await connectRedis();
  const redis = getRedis();
  if (redis) log.info('✅ Redis connected');
  else log.warn('⚠️ Redis not available, using file storage fallback');
  log.info('🔐 Initializing authentication...');
  await initAuth();
  const authorized = isAuthorized();
  if (authorized) log.info('✅ Token found and validated');
  else log.info('ℹ️ No token yet – waiting for OAuth');
  log.info('📦 Loading emotes...');
  const emotePools = await initializeEmotes(config.twitch.channels);
  setEmotePools(emotePools);
  log.info('✅ Emotes loaded');
  if (authorized && !botInitialized) {
    await initializeBot();
  } else if (!authorized) {
    log.info('No token, waiting for auth');
  }
  const port = config.server.port;
  server = app.listen(port, () => {
    log.info(`🌐 Server running on port ${port}`);
  });
}

// ========== SHUTDOWN ==========
async function shutdown() {
  log.info('Shutting down gracefully...');
  if (global._autoMessageTimer) clearInterval(global._autoMessageTimer);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (messageQueue) messageQueue.stop();
  if (eventSubClient) eventSubClient.disconnect();
  await drainQueues();
  if (global.twitchClient) global.twitchClient.disconnect();
  const redis = getRedis();
  if (redis) await redis.quit();
  if (server) {
    await new Promise(resolve => {
      server.close(() => { log.info('HTTP server closed'); resolve(); });
      setTimeout(() => { log.warn('Forcing server close'); resolve(); }, 5000);
    });
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('Unhandled Rejection', err);
  process.exit(1);
});

bootstrap().catch(err => {
  log.error('Bootstrap failed', err);
  process.exit(1);
});
