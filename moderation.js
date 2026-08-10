export class ModerationBrain {
  static getConfig() {
    return {
      systemPrompt: `You are a moderation AI. Analyze the user's message for toxicity, spam, and harmful content.
Return a JSON object with fields: toxic, spam, severity, reason.`,
      temperature: 0.1,
      maxTokens: 150,
    };
  }
  static async processResponse(reply, context) {
    try { return JSON.parse(reply); } catch (e) { return { toxic: false, spam: false, severity: 0, reason: 'parse error' }; }
  }
  static async score({ message }) {
    const lower = message.toLowerCase();
    const toxicWords = ['hate','kill','stupid','idiot','dumb','fuck','shit','damn'];
    let count = 0;
    for (const w of toxicWords) if (lower.includes(w)) count++;
    const score = Math.min(count * 20, 100);
    return { score, confidence: count > 0 ? 0.7 : 0.2, priority: 2, cost: 0.5 };
  }
}
