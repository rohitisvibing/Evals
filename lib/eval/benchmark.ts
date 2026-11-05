// Benchmark aggregation shared by the runner script and the dashboard.
import type { DecisionLabel, ResultStatus } from "../decision/schema";
import {
  abstention,
  accuracy,
  agreement,
  bootstrapCI,
  confusionMatrix,
  falsePositiveRate,
  latencyStats,
  macroF1,
  mcnemar,
  mean,
  perClass,
  wilson,
  type Pred,
} from "./metrics";
import type { FailureCode } from "./taxonomy";

// ------------------------------------------------------------ retrieval

/** Each group is one required piece of evidence; any chunk key in the group satisfies it. */
export type Groups = string[][];

export function groupRecallAtK(retrieved: string[], groups: Groups, k: number): number {
  const g = groups.filter((x) => x.length);
  if (!g.length) return NaN;
  const top = new Set(retrieved.slice(0, k));
  return g.filter((keys) => keys.some((key) => top.has(key))).length / g.length;
}

export function groupReciprocalRank(retrieved: string[], groups: Groups): number {
  const all = new Set(groups.flat());
  if (!all.size) return NaN;
  const i = retrieved.findIndex((r) => all.has(r));
  return i === -1 ? 0 : 1 / (i + 1);
}

export function groupNdcgAtK(retrieved: string[], groups: Groups, k: number): number {
  const g = groups.filter((x) => x.length);
  if (!g.length) return NaN;
  const satisfied = new Set<number>();
  let dcg = 0;
  retrieved.slice(0, k).forEach((key, i) => {
    const gi = g.findIndex((keys, idx) => !satisfied.has(idx) && keys.includes(key));
    if (gi !== -1) {
      satisfied.add(gi);
      dcg += 1 / Math.log2(i + 2);
    }
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, g.length); i++) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

export type RetrievalRow = { example_id: string; strategy: string; retrieved: string[]; groups: Groups; multi_page: boolean };

export function summarizeRetrieval(rows: RetrievalRow[], ks: number[]) {
  const strategies = [...new Set(rows.map((r) => r.strategy))];
  return strategies.map((strategy) => {
    const rs = rows.filter((r) => r.strategy === strategy && r.groups.some((g) => g.length));
    const at = Object.fromEntries(
      ks.map((k) => {
        const rec = rs.map((r) => groupRecallAtK(r.retrieved, r.groups, k));
        const full = rs.map((r) => (groupRecallAtK(r.retrieved, r.groups, k) === 1 ? 1 : 0));
        const multi = rs.filter((r) => r.multi_page).map((r) => (groupRecallAtK(r.retrieved, r.groups, k) === 1 ? 1 : 0));
        return [
          k,
          {
            recall: mean(rec),
            recall_ci: bootstrapCI(rec, (s) => mean(s)),
            full_recall: mean(full),
            multi_page_full_recall: multi.length ? mean(multi) : null,
            ndcg: mean(rs.map((r) => groupNdcgAtK(r.retrieved, r.groups, k))),
          },
        ];
      }),
    );
    return { strategy, n: rs.length, mrr: mean(rs.map((r) => groupReciprocalRank(r.retrieved, r.groups))), at_k: at };
  });
}

// ------------------------------------------------------------ decisions

export type DecisionRow = {
  example_id: string;
  run_id?: string;
  condition: string; // "oracle" | "e2e:lexical" | ...
  provider: "jev" | "llm_judge";
  gold: DecisionLabel;
  pred: Pred;
  status: ResultStatus;
  latency_ms: number;
  est_cost_usd: number | null;
  citation_valid: boolean | null;
  evidence_recall: number | null; // share of gold evidence groups present in what the model saw
  failure: FailureCode | null;
  categories: string[];
  ambiguous: boolean;
  confidence: number | null;
};

function summarizeSet(rows: DecisionRow[]) {
  const gold = rows.map((r) => r.gold);
  const pred = rows.map((r) => r.pred);
  const correct = rows.filter((r) => r.pred === r.gold).length;
  const answered = rows.filter((r) => r.pred !== null);
  const cites = rows.filter((r) => r.pred === r.gold && r.citation_valid !== null);
  const costs = rows.map((r) => r.est_cost_usd).filter((c): c is number => c !== null);
  return {
    n: rows.length,
    accuracy: accuracy(gold, pred),
    accuracy_ci_wilson: wilson(correct, rows.length),
    accuracy_ci_bootstrap: bootstrapCI(rows, (s) => accuracy(s.map((r) => r.gold), s.map((r) => r.pred))),
    macro_f1: macroF1(gold, pred),
    per_class: perClass(gold, pred),
    confusion: confusionMatrix(gold, pred).matrix,
    false_positive_rate_supported: falsePositiveRate(gold, pred),
    ...abstention(gold, pred),
    valid_output_rate: rows.length ? answered.length / rows.length : NaN,
    // Of correct answers, how many cite valid evidence ("right for the right reason").
    citation_validity_when_correct: cites.length ? cites.filter((r) => r.citation_valid).length / cites.length : null,
    latency: latencyStats(rows.map((r) => r.latency_ms)),
    cost_per_eval_usd: costs.length ? mean(costs) : null,
    total_cost_usd: costs.reduce((a, b) => a + b, 0),
    statuses: count(rows.map((r) => r.status)),
    failures: count(rows.map((r) => r.failure).filter(Boolean) as string[]),
  };
}

export function summarizeDecisions(rows: DecisionRow[]) {
  const conditions = [...new Set(rows.map((r) => r.condition))];
  return conditions.map((condition) => {
    const c = rows.filter((r) => r.condition === condition);
    const jev = c.filter((r) => r.provider === "jev");
    const judge = c.filter((r) => r.provider === "llm_judge");
    const ids = [...new Set(c.map((r) => r.example_id))];
    const pair = ids
      .map((id) => [jev.find((r) => r.example_id === id), judge.find((r) => r.example_id === id)] as const)
      .filter(([a, b]) => a && b) as [DecisionRow, DecisionRow][];
    const unambiguous = (rs: DecisionRow[]) => rs.filter((r) => !r.ambiguous);
    const byCategory = (rs: DecisionRow[]) => {
      const cats = [...new Set(rs.flatMap((r) => r.categories))];
      return Object.fromEntries(
        cats.map((cat) => {
          const sub = rs.filter((r) => r.categories.includes(cat));
          return [cat, { n: sub.length, accuracy: accuracy(sub.map((r) => r.gold), sub.map((r) => r.pred)) }];
        }),
      );
    };
    return {
      condition,
      jev: jev.length ? { ...summarizeSet(jev), unambiguous_accuracy: summarizeSet(unambiguous(jev)).accuracy, by_category: byCategory(jev) } : null,
      llm_judge: judge.length
        ? { ...summarizeSet(judge), unambiguous_accuracy: summarizeSet(unambiguous(judge)).accuracy, by_category: byCategory(judge) }
        : null,
      // Agreement is reported as agreement only — it says nothing about correctness.
      jev_vs_judge: pair.length
        ? {
            ...agreement(pair.map(([a]) => a.pred), pair.map(([, b]) => b.pred)),
            both_correct: pair.filter(([a, b]) => a.pred === a.gold && b.pred === b.gold).length,
            both_wrong_same_label: pair.filter(([a, b]) => a.pred !== a.gold && a.pred === b.pred && a.pred !== null).length,
            mcnemar: mcnemar(pair.map(([a]) => a.pred === a.gold), pair.map(([, b]) => b.pred === b.gold)),
          }
        : null,
    };
  });
}

/** Reliability table for a native confidence score (e.g., Jev). Reported, not assumed calibrated. */
export function reliability(rows: DecisionRow[], bins = 5) {
  const withConf = rows.filter((r) => r.confidence !== null && r.pred !== null);
  const table = Array.from({ length: bins }, (_, i) => {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const b = withConf.filter((r) => r.confidence! >= lo && (i === bins - 1 ? r.confidence! <= hi : r.confidence! < hi));
    return { lo, hi, n: b.length, accuracy: b.length ? b.filter((r) => r.pred === r.gold).length / b.length : null, mean_conf: b.length ? mean(b.map((r) => r.confidence!)) : null };
  });
  const ece = withConf.length
    ? table.reduce((s, t) => s + (t.n && t.accuracy !== null && t.mean_conf !== null ? (t.n / withConf.length) * Math.abs(t.accuracy - t.mean_conf) : 0), 0)
    : null;
  return { n: withConf.length, bins: table, ece };
}

function count(xs: string[]) {
  return xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}
