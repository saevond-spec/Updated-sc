import { createLogger } from '../logger/index.js';
const log = createLogger('AI-SAFEGUARD');
export function detectPromptInjection(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /ignore previous instructions/i,
    /disregard all previous instructions/i,
    /system prompt:/i,
    /override your instructions/i,
    /you are now/i,
    /your new role is/i,
    /act as if/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(lower)) {
      log.warn('Prompt injection detected', { text });
      return true;
    }
  }
  return false;
}
export function validateAIResponse(response, expectedFormat = 'text') {
  if (expectedFormat === 'json') {
    try { JSON.parse(response); } catch (e) {
      log.warn('AI response is not valid JSON', { response });
      throw new Error('Invalid JSON response');
    }
  }
  if (response.length > 5000) {
    log.warn('AI response too long', { length: response.length });
  }
  return true;
}
