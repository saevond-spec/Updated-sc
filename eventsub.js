import WebSocket from 'ws';
import { createLogger } from '../logger/index.js';
import { config } from '../config/index.js';
import bus from '../bus/index.js';
import { HelixClient } from './helix.js';
import { getRedis } from '../storage/redis.js';
import { getAccessToken } from './auth.js';
import { metrics } from '../utils/metrics.js';

const log = createLogger('EVENTSUB');

export class EventSubClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.helix = new HelixClient();
    this.broadcasterIds = new Set();

    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._baseDelay = 1000;
    this._maxDelay = 30000;
    this._isDisconnecting = false;

    this._connecting = null;
    this._isConnecting = false;
    this._heartbeatInterval = null;
    this._lastKeepalive = 0;
  }

  async connect() {
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      if (this._isDisconnecting) {
        reject(new Error('Client is disconnecting'));
        this._connecting = null;
        return;
      }

      this._cleanup();

      const url = config.eventsub.wssUrl || 'wss://eventsub.wss.twitch.tv/ws';
      log.info(`Connecting to EventSub WebSocket: ${url}`);

      const headers = {
        'Origin': config.server.publicUrl || 'https://your-app.onrender.com',
        'User-Agent': 'SweatyClanker/1.0',
      };

      const token = getAccessToken();
      if (!token) {
        reject(new Error('No user access token available – cannot connect to EventSub'));
        this._connecting = null;
        return;
      }
      log.debug('User token available for EventSub');

      try {
        this.ws = new WebSocket(url, { headers });
        this._isConnecting = true;

        const timeout = setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
            reject(new Error('Connection timeout'));
          }
          this._connecting = null;
          this._isConnecting = false;
        }, 15000);

        this.ws.on('open', () => {
          clearTimeout(timeout);
          log.info('EventSub WebSocket open, waiting for welcome...');
        });

        this.ws.on('message', (data) => {
          this._handleMessage(data, resolve, reject);
        });

        this.ws.on('error', (err) => {
          clearTimeout(timeout);
          log.error('EventSub WebSocket error', err);
          if (this._connecting) {
            reject(err);
            this._connecting = null;
            this._isConnecting = false;
          }
          if (!this._isDisconnecting) {
            this._scheduleReconnect();
          }
        });

        this.ws.on('close', (code, reason) => {
          clearTimeout(timeout);
          log.warn(`EventSub WebSocket closed: ${code} ${reason}`);
          this._isConnecting = false;
          if (this._connecting) {
            reject(new Error(`WebSocket closed: ${code}`));
            this._connecting = null;
          }
          if (!this._isDisconnecting) {
            this._scheduleReconnect();
          }
        });

        this._heartbeatInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);

      } catch (err) {
        this._isConnecting = false;
        reject(err);
        this._connecting = null;
      }
    });

    return this._connecting;
  }

  _handleMessage(data, resolve, reject) {
    try {
      const parsed = JSON.parse(data);
      const { metadata, payload } = parsed;

      if (metadata?.message_type === 'session_welcome') {
        this.sessionId = payload.session.id;
        global._eventsubSessionId = this.sessionId;
        log.info(`EventSub session established: ${this.sessionId}`);
        if (this._connecting) {
          resolve();
          this._connecting = null;
          this._isConnecting = false;
        }
        this._reconnectAttempts = 0;
        this._subscribeToAllEvents().catch(err => {
          log.error('Failed to subscribe to events', err);
        });
        return;
      }

      if (metadata?.message_type === 'session_keepalive') {
        const now = Date.now();
        if (this._lastKeepalive) {
          log.debug(`EventSub keepalive interval: ${now - this._lastKeepalive}ms`);
        }
        this._lastKeepalive = now;
        return;
      }

      if (metadata?.message_type === 'notification') {
        const event = payload.event;
        const type = metadata.subscription_type;
        bus.emit(`eventsub.${type}`, event);
        bus.emit('eventsub.event', { type, event });
        const redis = getRedis();
        if (redis) {
          const key = `eventsub:${type}:${Date.now()}`;
          redis.set(key, JSON.stringify(event), 'EX', 3600).catch(() => {});
        }
        this._handleEvent(type, event);
        return;
      }

      if (metadata?.message_type === 'session_reconnect') {
        log.info('EventSub session_reconnect received, reconnecting...');
        this._reconnect();
        return;
      }

      log.debug('Unhandled EventSub message type', metadata?.message_type);
    } catch (err) {
      log.error('Failed to parse EventSub message', err);
    }
  }

  async _subscribeToAllEvents() {
    if (!this.sessionId) return;

    const channels = config.twitch.channels;
    for (const ch of channels) {
      const clean = ch.replace('#', '').toLowerCase();
      try {
        const user = await this.helix.getUserByLogin(clean);
        if (user && user.id) {
          this.broadcasterIds.add(user.id);
        }
      } catch (err) {
        log.error(`Failed to resolve user ${clean}`, err);
      }
    }

    const broadcasterId = this.broadcasterIds.values().next().value;
    if (!broadcasterId) {
      log.warn('No broadcaster ID found, skipping EventSub subscriptions');
      return;
    }

    let moderatorId;
    try {
      moderatorId = await this.helix.getTokenOwnerId();
      log.info(`Moderator bot ID: ${moderatorId}`);
    } catch (err) {
      log.error('Failed to get moderator bot ID', err);
      return;
    }

    const subscriptions = [
      this.helix.subscribeFollow(broadcasterId, moderatorId),
      this.helix.subscribeShoutout(broadcasterId, moderatorId),
    ];

    const results = await Promise.allSettled(subscriptions);
    const successes = results.filter(r => r.status === 'fulfilled').length;
    const failures = results.filter(r => r.status === 'rejected').length;
    log.info(`EventSub subscriptions: ${successes} succeeded, ${failures} failed`);
  }

  _handleEvent(type, event) {
    const channel = config.twitch.channels[0] || '#channel';
    const message = this._generateResponse(type, event);
    if (message) {
      bus.emit('twitch.send', { channel, message });
    }
  }

  _generateResponse(type, event) {
    const templates = {
      'channel.follow': (e) => `Thanks for the follow, @${e.user_name}! ❤️`,
      'channel.shoutout.create': (e) => `Shoutout to @${e.recommended_user_name}! Go check them out! 📢`,
    };
    const template = templates[type];
    return template ? template(event) : null;
  }

  _cleanup() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this._isConnecting = false;
  }

  _scheduleReconnect() {
    if (this._isDisconnecting) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      log.error('Max reconnect attempts reached for EventSub – giving up');
      return;
    }
    this._reconnectAttempts++;
    const delay = Math.min(this._baseDelay * Math.pow(2, this._reconnectAttempts), this._maxDelay);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    const actualDelay = Math.min(jitter, this._maxDelay);
    log.info(`Scheduling EventSub reconnect attempt ${this._reconnectAttempts} in ${Math.round(actualDelay)}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect();
    }, actualDelay);
  }

  async _reconnect() {
    if (this._isDisconnecting) return;
    if (this._connecting) {
      log.debug('Reconnect called while already connecting – skipping');
      return;
    }
    metrics.eventsubReconnects.inc();
    log.info(`Reconnecting EventSub (attempt ${this._reconnectAttempts})`);
    this._cleanup();
    try {
      await this.connect();
      this._reconnectAttempts = 0;
      log.info('EventSub reconnected successfully');
    } catch (err) {
      log.error('EventSub reconnect failed', err);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this._isDisconnecting = true;
    this._cleanup();
    this._reconnectAttempts = 0;
    this._connecting = null;
    this._isConnecting = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    log.info('EventSub disconnected');
  }
}
