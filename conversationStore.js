import { getRedis } from '../storage/redis.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('CONVERSATION');
const MAX_HISTORY = 100;
const TTL_SECONDS = 86400;
export class ConversationStore {
  static async pushMessage(channel, role, content, username = null) {
    const redis = getRedis();
    if (!redis) return;
    const key = `conv:${channel}`;
    const entry = JSON.stringify({ role, content, ts: Date.now(), username });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, MAX_HISTORY - 1);
    await redis.expire(key, TTL_SECONDS);
  }
  static async getHistory(channel, limit = 20) {
    const redis = getRedis();
    if (!redis) return [];
    const key = `conv:${channel}`;
    const items = await redis.lrange(key, 0, limit - 1);
    return items.map(JSON.parse).reverse();
  }
  static async getLastActivity(channel) {
    const redis = getRedis();
    if (!redis) return 0;
    const ts = await redis.get(`lastact:${channel}`);
    return ts ? parseInt(ts) : 0;
  }
  static async updateLastActivity(channel, timestamp = Date.now()) {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(`lastact:${channel}`, String(timestamp), 'EX', TTL_SECONDS);
  }
}
