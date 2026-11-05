// Cost estimates (USD). Prices are configuration, verified 2026-10-29:
//   Jev (jev-1.14.0): $0.042 / Mtok input, output free (docs.typesafe.ai/models)
//   google/gemma-4-31b-it:free: $0 (OpenRouter); paid variant $0.20 in / $0.40 out
//   baai/bge-m3 embeddings: $0.01 / Mtok (OpenRouter)

function price(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function jevCost(inputTokens: number | null): number | null {
  if (inputTokens == null) return null;
  return (inputTokens * price("JEV_PRICE_INPUT_PER_MTOK", 0.042)) / 1e6;
}

export function judgeCost(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  const free = model.endsWith(":free");
  const pin = price("JUDGE_PRICE_INPUT_PER_MTOK", free ? 0 : NaN);
  const pout = price("JUDGE_PRICE_OUTPUT_PER_MTOK", free ? 0 : NaN);
  if (!Number.isFinite(pin) || !Number.isFinite(pout)) return null;
  return ((inputTokens ?? 0) * pin + (outputTokens ?? 0) * pout) / 1e6;
}

export function embeddingCost(tokens: number | null): number | null {
  if (tokens == null) return null;
  return (tokens * price("EMBEDDING_PRICE_PER_MTOK", 0.01)) / 1e6;
}

// openai/gpt-4.1-nano via OpenRouter: $0.10 in / $0.40 out per Mtok (verified 2026-11-05).
export function answerCost(inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  return ((inputTokens ?? 0) * price("ANSWER_PRICE_INPUT_PER_MTOK", 0.1) + (outputTokens ?? 0) * price("ANSWER_PRICE_OUTPUT_PER_MTOK", 0.4)) / 1e6;
}
