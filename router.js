import { brains } from './index.js';
import { getRedis } from '../storage/redis.js';
export async function scoreBrains(channel, user, message, context = {}) {
  const scores = [];
  for (const [name, Brain] of Object.entries(brains)) {
    const scoreFn = Brain.score || (() => ({ score: 0, confidence: 0, priority: 1, cost: 1 }));
    const result = await scoreFn({ channel, user, message, context });
    scores.push({ name, ...result });
  }
  const weighted = scores.map(s => ({
    name: s.name,
    weighted: (s.score || 0) * (s.confidence || 1) * (s.priority || 1) / (s.cost || 1)
  }));
  weighted.sort((a, b) => b.weighted - a.weighted);
  let selected = weighted[0]?.name || 'conversation';
  const redis = getRedis();
  if (redis) {
    const override = await redis.get(`brain:${channel}`);
    if (override && brains[override]) selected = override;
  }
  return selected;
}
