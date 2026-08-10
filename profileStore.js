import { getRedis } from '../storage/redis.js';
const TTL_SECONDS = 2592000; // 30 days
export class ProfileStore {
  static async get(channel, viewer) {
    const redis = getRedis();
    if (!redis) return { firstSeen: Date.now(), lastSeen: Date.now(), preferences: {}, notes: [] };
    const data = await redis.get(`profile:${channel}:${viewer}`);
    return data ? JSON.parse(data) : { firstSeen: Date.now(), lastSeen: Date.now(), preferences: {}, notes: [] };
  }
  static async update(channel, viewer, updates) {
    const redis = getRedis();
    if (!redis) return;
    const profile = await this.get(channel, viewer);
    Object.assign(profile, updates, { lastSeen: Date.now() });
    await redis.set(`profile:${channel}:${viewer}`, JSON.stringify(profile), 'EX', TTL_SECONDS);
  }
  static async addNote(channel, viewer, note) {
    const profile = await this.get(channel, viewer);
    profile.notes.push({ text: note, timestamp: Date.now() });
    await this.update(channel, viewer, profile);
  }
}
