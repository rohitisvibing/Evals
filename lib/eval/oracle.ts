import { createHash } from "node:crypto";

export function deterministicShuffle<T>(xs: T[], seed: string): T[] {
  return xs
    .map((x, i) => ({ x, h: createHash("sha256").update(`${seed}:${i}`).digest("hex") }))
    .sort((a, b) => a.h.localeCompare(b.h))
    .map((v) => v.x);
}

/**
 * Oracle evidence: one gold chunk per required evidence group, padded with the
 * best-ranked non-gold chunks to at least `size`, in a seeded order so gold is
 * not always first. Used by both the claim and QA benchmarks.
 */
export function oracleKeys(groups: string[][], rankedKeys: string[], seed: string, size = 5): { keys: string[]; gold: string[] } {
  const gold = [...new Set(groups.map((g) => g[0]).filter(Boolean))];
  const allGold = new Set(groups.flat());
  const distractors = rankedKeys.filter((k) => !allGold.has(k));
  const keys = [...gold, ...distractors].slice(0, Math.max(size, gold.length));
  return { keys: deterministicShuffle(keys, seed), gold };
}
