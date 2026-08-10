import { registerBuiltin } from './index.js';
import { brains, defaultBrain } from '../brains/index.js';
import { getRedis } from '../storage/redis.js';

registerBuiltin('!help', async (user, channel, client) => {
  const brainList = Object.keys(brains).join(', ');
  return `Commands: !help, !uptime, !bot, !about, !brain <${brainList}>, !commands, and custom commands.`;
}, 'Shows this help');

registerBuiltin('!uptime', async (user, channel, client) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  return `I've been online for ${hours}h ${minutes}m.`;
}, 'Shows bot uptime');

registerBuiltin('!bot', async () => {
  return "I'm SweatyClanker, a multi‑brain AI bot powered by DeepSeek!";
}, 'About the bot');

registerBuiltin('!about', async () => {
  return 'I use DeepSeek AI with multiple brains. Source: https://github.com/your/repo';
}, 'About the project');

registerBuiltin('!brain', async (user, channel, client, message) => {
  const parts = message.split(' ');
  if (parts.length < 2) {
    return `Current brain: default. Available: ${Object.keys(brains).join(', ')}`;
  }
  const requested = parts[1].toLowerCase();
  if (brains[requested]) {
    const redis = getRedis();
    if (redis) await redis.set(`brain:${channel}`, requested);
    return `Switching brain to ${requested} mode.`;
  }
  return `Brain '${requested}' not found. Available: ${Object.keys(brains).join(', ')}`;
}, 'Switch or list brains');

registerBuiltin('!commands', async () => {
  const redis = getRedis();
  if (!redis) return 'No custom commands loaded.';
  const keys = await redis.keys('cmd:*');
  const cmds = await Promise.all(keys.map(async k => {
    const data = await redis.get(k);
    return data ? JSON.parse(data).name : null;
  }));
  const list = cmds.filter(Boolean).join(', ');
  return list ? `Custom commands: ${list}` : 'No custom commands.';
}, 'List custom commands');
