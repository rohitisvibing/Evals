import { DECISION_LABELS, type DecisionLabel } from "../decision/schema";

export type Pred = DecisionLabel | null; // null = provider produced no valid decision

export const POSITIVE_CLASS: DecisionLabel = "supported";

// ---------------------------------------------------------------- decisions

export function confusionMatrix(gold: DecisionLabel[], pred: Pred[]) {
  const cols = [...DECISION_LABELS, "no_decision"] as const;
  const m: Record<DecisionLabel, Record<(typeof cols)[number], number>> = Object.fromEntries(
    DECISION_LABELS.map((g) => [g, Object.fromEntries(cols.map((c) => [c, 0]))]),
  ) as never;
  gold.forEach((g, i) => {
    m[g][pred[i] ?? "no_decision"]++;
  });
  return { rows: DECISION_LABELS, cols, matrix: m };
}

export function accuracy(gold: DecisionLabel[], pred: Pred[]): number {
  if (gold.length === 0) return NaN;
  return gold.filter((g, i) => pred[i] === g).length / gold.length;
}

export function perClass(gold: DecisionLabel[], pred: Pred[]) {
  return DECISION_LABELS.map((label) => {
    let tp = 0, fp = 0, fn = 0;
    gold.forEach((g, i) => {
      const p = pred[i];
      if (p === label && g === label) tp++;
      else if (p === label) fp++;
      else if (g === label) fn++;
    });
    const precision = tp + fp ? tp / (tp + fp) : NaN;
    const recall = tp + fn ? tp / (tp + fn) : NaN;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : NaN;
    return { label, support: tp + fn, tp, fp, fn, precision, recall, f1 };
  });
}

export function macroF1(gold: DecisionLabel[], pred: Pred[]): number {
  const f = perClass(gold, pred).map((c) => (Number.isNaN(c.f1) ? 0 : c.f1));
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/** FPR with positive = "supported": P(pred=supported | gold≠supported). */
export function falsePositiveRate(gold: DecisionLabel[], pred: Pred[], positive = POSITIVE_CLASS): number {
  const neg = gold.map((g, i) => [g, pred[i]] as const).filter(([g]) => g !== positive);
  if (!neg.length) return NaN;
  return neg.filter(([, p]) => p === positive).length / neg.length;
}

export function abstention(gold: DecisionLabel[], pred: Pred[]) {
  const abst = "insufficient_evidence";
  const n = gold.length;
  const predAbst = pred.filter((p) => p === abst).length;
  const goldAbst = gold.filter((g) => g === abst).length;
  const both = gold.filter((g, i) => g === abst && pred[i] === abst).length;
  return {
    abstention_rate: n ? predAbst / n : NaN,
    // Of the abstentions made, how many were warranted.
    correct_abstention_rate: predAbst ? both / predAbst : NaN,
    // Of the cases that warranted abstention, how many were caught.
    abstention_recall: goldAbst ? both / goldAbst : NaN,
    // Answered when it should have abstained.
    failed_to_abstain: gold.filter((g, i) => g === abst && pred[i] !== abst && pred[i] !== null).length,
    // Abstained when the answer was determinable.
    incorrect_abstention: gold.filter((g, i) => g !== abst && pred[i] === abst).length,
  };
}

export function agreement(a: Pred[], b: Pred[]) {
  const pairs = a.map((x, i) => [x, b[i]] as const).filter(([x, y]) => x !== null && y !== null) as [DecisionLabel, DecisionLabel][];
  const n = pairs.length;
  if (!n) return { n, agreement: NaN, kappa: NaN };
  const po = pairs.filter(([x, y]) => x === y).length / n;
  let pe = 0;
  for (const l of DECISION_LABELS) {
    pe += (pairs.filter(([x]) => x === l).length / n) * (pairs.filter(([, y]) => y === l).length / n);
  }
  return { n, agreement: po, kappa: pe === 1 ? NaN : (po - pe) / (1 - pe) };
}

// ---------------------------------------------------------------- uncertainty

/** Deterministic PRNG so reported CIs are reproducible. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI for a statistic over paired examples. */
export function bootstrapCI<T>(items: T[], stat: (sample: T[]) => number, opts: { iters?: number; alpha?: number; seed?: number } = {}) {
  const { iters = 2000, alpha = 0.05, seed = 1234 } = opts;
  if (!items.length) return { lo: NaN, hi: NaN };
  const rnd = mulberry32(seed);
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const s = Array.from({ length: items.length }, () => items[Math.floor(rnd() * items.length)]);
    const v = stat(s);
    if (!Number.isNaN(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return { lo: quantile(vals, alpha / 2), hi: quantile(vals, 1 - alpha / 2) };
}

/** Wilson score interval for a proportion. */
export function wilson(successes: number, n: number, z = 1.96) {
  if (!n) return { lo: NaN, hi: NaN };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** Exact two-sided McNemar test (binomial) on discordant pairs. */
export function mcnemar(aCorrect: boolean[], bCorrect: boolean[]) {
  let b = 0, c = 0;
  aCorrect.forEach((a, i) => {
    if (a && !bCorrect[i]) b++;
    else if (!a && bCorrect[i]) c++;
  });
  const n = b + c;
  if (!n) return { a_only: b, b_only: c, p_value: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i) * 0.5 ** n;
  return { a_only: b, b_only: c, p_value: Math.min(1, 2 * tail) };
}

function binom(n: number, k: number) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function latencyStats(ms: number[]) {
  const s = ms.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { n: s.length, p50: quantile(s, 0.5), p90: quantile(s, 0.9), p95: quantile(s, 0.95), max: s.at(-1) ?? NaN };
}

// ---------------------------------------------------------------- retrieval

export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (!relevant.length) return NaN;
  const top = new Set(retrieved.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

/** All relevant passages retrieved (needed for multi-page claims). */
export function fullRecallAtK(retrieved: string[], relevant: string[], k: number): number {
  const r = recallAtK(retrieved, relevant, k);
  return Number.isNaN(r) ? NaN : r === 1 ? 1 : 0;
}

export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  if (!relevant.length) return NaN;
  const rel = new Set(relevant);
  const i = retrieved.findIndex((r) => rel.has(r));
  return i === -1 ? 0 : 1 / (i + 1);
}

export function ndcgAtK(retrieved: string[], relevant: string[], k: number): number {
  if (!relevant.length) return NaN;
  const rel = new Set(relevant);
  const dcg = retrieved.slice(0, k).reduce((s, r, i) => s + (rel.has(r) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal ? dcg / ideal : NaN;
}

export function mean(xs: number[]): number {
  const v = xs.filter((x) => !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

// ---------------------------------------------------------------- citations

export type CitationCheck = {
  /** Every cited chunk was among the evidence the evaluator received. */
  refs_in_evidence: boolean;
  /** Judge only: every quote was found verbatim (normalized) in its passage. */
  quotes_verified: boolean | null;
  /** At least one non-neutral cited chunk is gold-relevant (when gold passages exist). */
  cites_gold: boolean | null;
  /** Combined validity used on the dashboard. */
  valid: boolean;
};

export function checkCitations(
  refs: { chunk_key: string; stance: string; quote?: string; quote_verified?: boolean }[],
  evidenceSent: string[],
  goldRelevant: string[],
  goldLabel: DecisionLabel,
): CitationCheck {
  const sent = new Set(evidenceSent);
  const substantive = refs.filter((r) => r.stance !== "neutral");
  const refs_in_evidence = refs.every((r) => sent.has(r.chunk_key));
  const quoted = refs.filter((r) => r.quote);
  const quotes_verified = quoted.length ? quoted.every((r) => r.quote_verified) : null;
  const gold = new Set(goldRelevant);
  const cites_gold = goldRelevant.length ? substantive.some((r) => gold.has(r.chunk_key)) : null;
  // For insufficient-evidence gold, a valid answer need not cite anything.
  const needsCitation = goldLabel !== "insufficient_evidence";
  const valid =
    refs_in_evidence && quotes_verified !== false && (!needsCitation || (substantive.length > 0 && cites_gold !== false));
  return { refs_in_evidence, quotes_verified, cites_gold, valid };
}
