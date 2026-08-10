export class CoachBrain {
  static getConfig() {
    return {
      systemPrompt: `You are a coach for Naraka Bladepoint. Provide concise, actionable advice on combos, weapons, movement, and strategy.`,
      temperature: 0.5,
      maxTokens: 1024,
    };
  }
  static async score({ message }) {
    const lower = message.toLowerCase();
    const keywords = ['naraka','weapon','combo','blade','hero','skill','ability','damage','heal','attack','dodge','parry'];
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 15;
    score = Math.min(score, 100);
    return { score, confidence: score > 30 ? 0.8 : 0.3, priority: 1.5, cost: 1 };
  }
}
