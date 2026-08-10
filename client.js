import tmi from 'tmi.js';
import { config } from '../config/index.js';
import { getAccessToken } from './auth.js';
import { createLogger } from '../logger/index.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { ReconnectStateMachine } from '../state/reconnectState.js';
import { metrics } from '../utils/metrics.js';

const log = createLogger('IRC');
const debugMode = process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development';

export class TwitchClient {
  static _activeClients = 0;

  constructor() {
    this.client = null;
    this.channels = config.twitch.channels;
    this.connected = false;
    this.rateLimiter = new RateLimiter(20, 30000);

    this.eventListeners = {
      message: [], connected: [], disconnected: [], reconnecting: [],
      roomstate: [], userstate: [], usernotice: [], clearchat: [], clearmsg: [],
      join: [], part: [], whisper: [],
    };

    this._disconnecting = false;
    this._reconnectAttempt = 0;
    this._maxReconnectAttempts = 20;
    this._state = 'idle';
    this._lastPing = null;   // fixed: null instead of 0
    this._reconnectTimer = null;

    this.stateMachine = new ReconnectStateMachine({
      maxAttempts: this._maxReconnectAttempts,
      baseDelay: 1000,
      maxDelay: 30000,
      jitter: true,
    });

    this.stateMachine.on('reconnecting', (attempt) => {
      metrics.ircReconnects.inc();
      this._reconnectAttempt = attempt;
      this._state = 'reconnecting';
      log.info(`Reconnect attempt ${attempt} (state: ${this._state})`);
      this.emit('reconnecting');
      this.reconnect();
    });

    this.stateMachine.on('failed', () => {
      this._state = 'failed';
      log.error('Reconnection failed after max attempts');
      this.emit('disconnected', 'Max attempts');
    });

    TwitchClient._activeClients++;
    log.debug(`Active IRC clients: ${TwitchClient._activeClients}`);
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this._state === 'connecting') {
        log.warn('Connection already in progress');
        reject(new Error('Connection already in progress'));
        return;
      }

      if (this.client) {
        log.warn('Client already exists, disconnecting first');
        this.disconnect();
      }

      const token = getAccessToken();
      if (!token) {
        this._state = 'failed';
        reject(new Error('No access token available'));
        return;
      }

      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      this._state = 'connecting';
      log.info(`Connecting to Twitch IRC... (state: ${this._state}, attempt: ${this._reconnectAttempt})`);
      this.stateMachine.reset();

      this.client = new tmi.Client({
        options: { debug: debugMode },
        identity: {
          username: config.twitch.username,
          password: `oauth:${token}`,
        },
        channels: this.channels,
        connection: { reconnect: false, secure: true },
      });

      // ---- FIX: Add error listener ----
      this.client.on('error', (err) => {
        log.error('IRC client error:', err.message);
        this.emit('error', err);
      });

      this.client.on('ping', () => {
        this._lastPing = Date.now();
        log.debug('PING received from Twitch');
      });

      // ---- FIX: Guard PONG latency ----
      this.client.on('pong', (latency) => {
        if (this._lastPing) {
          const measured = Date.now() - this._lastPing;
          log.debug(`PONG received, latency: ${measured}ms`);
        } else {
          log.debug('PONG received but no previous PING timestamp');
        }
      });

      this.client.on('connected', (addr, port) => {
        if (this.stateMachine._timer) {
          clearTimeout(this.stateMachine._timer);
          this.stateMachine._timer = null;
        }
        this.connected = true;
        this._state = 'connected';
        this._reconnectAttempt = 0;
        this.stateMachine.connected();
        log.info(`✅ Connected to ${addr}:${port} (state: ${this._state})`);
        this.emit('connected', addr, port);
        resolve();
      });

      this.client.on('disconnected', (reason) => {
        this.connected = false;
        this._state = 'disconnected';
        log.warn(`Disconnected: ${reason} (state: ${this._state})`);
        this.emit('disconnected', reason);
        if (!this._disconnecting) {
          this.stateMachine.disconnected();
        }
      });

      this.client.on('reconnect', () => {
        this._state = 'reconnecting';
        log.warn('Received RECONNECT from Twitch (state: reconnecting)');
        if (!this._disconnecting) {
          this.stateMachine.disconnected();
        }
      });

      this.client.on('message', (channel, user, message, self) => {
        if (self) return;
        log.info(`📡 RAW IRC: ${user.username} @ ${channel}: ${message}`);
        this.emit('message', channel, user, message, false);
      });

      this.client.on('roomstate', (channel, state) => this.emit('roomstate', channel, state));
      this.client.on('userstate', (channel, state) => this.emit('userstate', channel, state));
      this.client.on('usernotice', (channel, user, msg, tags) => this.emit('usernotice', channel, user, msg, tags));
      this.client.on('clearchat', (channel) => this.emit('clearchat', channel));
      this.client.on('clearmsg', (channel, user, msg, tags) => this.emit('clearmsg', channel, user, msg, tags));
      this.client.on('join', (channel, username, self) => {
        if (self) log.info(`Joined ${channel}`);
        this.emit('join', channel, username, self);
      });
      this.client.on('part', (channel, username, self) => {
        if (self) log.info(`Left ${channel}`);
        this.emit('part', channel, username, self);
      });
      this.client.on('whisper', (from, user, message, self) => {
        if (self) return;
        this.emit('whisper', from, user, message);
      });

      const timeout = setTimeout(() => {
        if (!this.connected) {
          this._state = 'failed';
          this.stateMachine.failed();
          reject(new Error('Connection timeout'));
        }
      }, 15000);

      this.client.connect().catch((err) => {
        clearTimeout(timeout);
        this._state = 'failed';
        this.stateMachine.failed();
        reject(err);
      });
    });
  }

  disconnect() {
    this._disconnecting = true;
    this._state = 'disconnecting';
    log.info(`Disconnecting IRC (state: ${this._state})`);
    this.stateMachine.reset();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.client) {
      // FIX: Catch disconnect promise
      this.client.disconnect().catch(err => log.error('Error disconnecting IRC:', err));
      this.client = null;
    }
    this.connected = false;
    this._disconnecting = false;
    TwitchClient._activeClients--;
    log.debug(`Active IRC clients: ${TwitchClient._activeClients}`);
  }

  async reconnect() {
    if (this._disconnecting) {
      log.debug('Reconnect aborted – disconnecting in progress');
      return;
    }
    if (this.connected || this._state === 'connected') {
      log.debug('Already connected, skipping reconnect');
      return;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    log.info(`Attempting reconnect (attempt ${this._reconnectAttempt})`);
    try {
      this.disconnect();
      await this.connect();
    } catch (err) {
      log.error('Reconnection attempt failed', err);
      this.stateMachine.failed();
    }
  }

  async say(channel, message) {
    if (!this.connected || !this.client) {
      log.warn('Cannot send message, not connected');
      return false;
    }
    await this.rateLimiter.wait(channel);
    try {
      await this.client.say(channel, message);
      log.info(`📤 OUT: ${channel}: ${message}`);
      return true;
    } catch (err) {
      log.error(`Failed to send message to ${channel}`, err);
      return false;
    }
  }

  on(event, fn) {
    if (this.eventListeners[event]) this.eventListeners[event].push(fn);
  }

  emit(event, ...args) {
    (this.eventListeners[event] || []).forEach(fn => fn(...args));
  }
}
