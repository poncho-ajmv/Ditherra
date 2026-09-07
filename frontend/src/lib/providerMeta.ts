/**
 * Static hints about each provider that the backend doesn't report: which ones
 * we recommend, and a rough price tier.
 *
 * Price is a tier, not a number, on purpose. Per-token prices change often and
 * are the provider's to set — a hardcoded "$0.15" rots within weeks and lies
 * the moment it does. A tier ("cheap", "mid", "premium") stays true far longer
 * and answers the only question the tier is for: will this cost me much?
 */

export type PriceTier = "free" | "cheap" | "mid" | "premium" | "varies";

// Named in providers.json. Anything not listed falls back to "mid".
export const PRICE_TIER: Record<string, PriceTier> = {
  ollama: "free",
  lmstudio: "free",
  groq: "free",       // generous free tier
  gemini: "cheap",
  deepseek: "cheap",
  qwen: "mid",
  "qwen-vl": "mid",
  glm: "mid",
  kimi: "mid",
  openai: "premium",
  codex: "varies",
  openrouter: "varies",  // hundreds of models, some :free
};

// Why each is recommended shows in the badge tooltip.
export const RECOMMENDED: Record<string, string> = {
  codex: "Official Codex login with a separate ChatGPT account",
  gemini: "Only provider that generates concept art",
  deepseek: "Cheap and strong at tool calling",
  groq: "Very fast, generous free tier",
};

export const isRecommended = (name: string) => name in RECOMMENDED;
export const priceTier = (name: string): PriceTier => PRICE_TIER[name] ?? "mid";
