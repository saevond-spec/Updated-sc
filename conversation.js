import { getSystemPrompt } from '../../personality.js';
export class ConversationBrain {
  static getConfig() {
    return { systemPrompt: getSystemPrompt(), temperature: 0.7, maxTokens: 1024 };
  }
  static async processResponse(reply, context) { return reply; }
  static async score({ message }) { return { score: 50, confidence: 0.8, priority: 1, cost: 1 }; }
}
