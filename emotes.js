import { createLogger } from '../logger/index.js';
const log = createLogger('EMOTES');
export async function initializeEmotes(channels) {
  log.info(`Emotes initialized for ${channels.length} channels (stub)`);
  return new Map();
}
let emotePools = new Map();
export function getRandomEmote(channel) {
  const pool = emotePools.get(channel) || [];
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}
export function setEmotePools(pools) { emotePools = pools; }
