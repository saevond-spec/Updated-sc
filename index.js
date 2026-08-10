import { getRedis } from '../storage/redis.js';
import { createLogger } from '../logger/index.js';
const log = createLogger('COMMANDS');
export const builtins = new Map();

export function registerBuiltin(name, handler, description) {
  builtins.set(name, { handler, description });
}

export async function loadCustomCommands() {
  const redis = getRedis();
  if (!redis) {
    log.warn('No Redis, custom commands not loaded');
    return new Map();
  }
  const keys = await redis.keys('cmd:*');
  const commands = new Map();
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const cmd = JSON.parse(data);
      commands.set(cmd.name, cmd);
    }
  }
  log.info(`Loaded ${commands.size} custom commands from Redis`);
  return commands;
}

export async function saveCustomCommand(name, response, role = 'all') {
  const redis = getRedis();
  if (!redis) return false;
  const cmd = { name, response, role };
  await redis.set(`cmd:${name}`, JSON.stringify(cmd));
  return true;
}

export async function deleteCustomCommand(name) {
  const redis = getRedis();
  if (!redis) return false;
  await redis.del(`cmd:${name}`);
  return true;
}
