import { getSystemPrompt } from '../../personality.js';
export function buildSystemPrompt(channel, user, context = {}) {
  const base = getSystemPrompt();
  let extra = '';
  if (context.game) extra += `\nCurrent game: ${context.game}`;
  if (context.recentEvents) extra += `\nRecent events: ${context.recentEvents}`;
  return `${base}${extra}`;
}
export function buildUserPrompt(message, username, history = []) {
  let prompt = '';
  if (history.length) {
    prompt += 'Previous conversation:\n';
    for (const entry of history.slice(-5)) {
      const displayName = entry.username || (entry.role === 'user' ? 'User' : 'Bot');
      prompt += `${displayName}: ${entry.content}\n`;
    }
  }
  prompt += `\n${username}: ${message}`;
  return prompt;
}
