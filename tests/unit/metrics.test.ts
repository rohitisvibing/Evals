import { describe, expect, it } from "vitest";
import {
  abstention, accuracy, agreement, bootstrapCI, checkCitations, confusionMatrix, falsePositiveRate,
  mcnemar, ndcgAtK, perClass, recallAtK, reciprocalRank, wilson, latencyStats,
} from "@/lib/eval/metrics";
import { groupNdcgAtK, groupRecallAtK, groupReciprocalRank, reliability, summarizeDecisions } from "@/lib/eval/benchmark";
import { suggestFailure } from "@/lib/eval/taxonomy";
import type { DecisionLabel } from "@/lib/decision/schema";

const S = "supported", C = "contradicted", I = "insufficient_evidence";
const gold: DecisionLabel[] = [S, S, C, C, I, I];
const pred = [S, C, C, S, I, null] as (DecisionLabel | null)[];

describe("decision metrics", () => {
  it("accuracy counts null predictions as wrong", () => expect(accuracy(gold, pred)).toBeCloseTo(3 / 6));

  it("confusion matrix includes a no_decision column", () => {
    const m = confusionMatrix(gold, pred).matrix;
    expect(m.supported).toEqual({ supported: 1, contradicted: 1, insufficient_evidence: 0, no_decision: 0 });
    expect(m.insufficient_evidence.no_decision).toBe(1);
  });

  it("per-class precision/recall/F1", () => {
    const sup = perClass(gold, pred).find((c) => c.label === S)!;
    expect(sup.tp).toBe(1);
    expect(sup.fp).toBe(1);
    expect(sup.precision).toBeCloseTo(0.5);
    expect(sup.recall).toBeCloseTo(0.5);
    expect(sup.f1).toBeCloseTo(0.5);
  });

  it("FPR uses positive=supported over gold negatives", () => {
    // negatives: C, C, I, I -> predicted S once
    expect(falsePositiveRate(gold, pred)).toBeCloseTo(1 / 4);
  });

  it("abstention metrics", () => {
    const a = abstention(gold, pred);
    expect(a.abstention_rate).toBeCloseTo(1 / 6);
    expect(a.correct_abstention_rate).toBe(1);
    expect(a.abstention_recall).toBeCloseTo(0.5);
    expect(a.incorrect_abstention).toBe(0);
  });

  it("agreement and kappa ignore missing predictions", () => {
    const a = agreement([S, S, C, null], [S, C, C, S]);
    expect(a.n).toBe(3);
    expect(a.agreement).toBeCloseTo(2 / 3);
    expect(agreement([S, C, I], [S, C, I]).kappa).toBeCloseTo(1);
  });

  it("Wilson and bootstrap intervals contain the point estimate and are reproducible", () => {
    const w = wilson(30, 50);
    expect(w.lo).toBeLessThan(0.6);
    expect(w.hi).toBeGreaterThan(0.6);
    const xs = Array.from({ length: 50 }, (_, i) => (i % 5 < 3 ? 1 : 0));
    const mean = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length;
    expect(bootstrapCI(xs, mean)).toEqual(bootstrapCI(xs, mean));
    const ci = bootstrapCI(xs, mean);
    expect(ci.lo).toBeLessThan(0.6);
    expect(ci.hi).toBeGreaterThan(0.6);
  });

  it("exact McNemar", () => {
    const r = mcnemar([true, true, true, true, true, false], [false, false, false, false, false, false]);
    expect(r.a_only).toBe(5);
    expect(r.p_value).toBeCloseTo(0.0625);
  });

  it("latency percentiles", () => {
    expect(latencyStats([100, 200, 300, 400]).p50).toBe(250);
  });
});

describe("retrieval metrics", () => {
  it("flat recall/MRR/nDCG", () => {
    expect(recallAtK(["a", "b", "c"], ["c", "z"], 3)).toBe(0.5);
    expect(reciprocalRank(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
    expect(ndcgAtK(["c", "x"], ["c"], 2)).toBe(1);
  });

  it("group recall: alternatives satisfy a group; multiple groups require all", () => {
    const groups = [["p5", "p35"], ["p41"]];
    expect(groupRecallAtK(["p35", "x", "p41"], groups, 3)).toBe(1);
    expect(groupRecallAtK(["p35", "x", "p41"], groups, 2)).toBe(0.5);
    expect(groupReciprocalRank(["x", "p5"], groups)).toBe(0.5);
    expect(Number.isNaN(groupRecallAtK(["x"], [], 3))).toBe(true);
    expect(groupNdcgAtK(["p5", "p41"], groups, 2)).toBeCloseTo(1);
  });
});

describe("citations and taxonomy", () => {
  it("citation validity requires refs within evidence, verified quotes and a gold hit", () => {
    const sent = ["a", "b"];
    expect(checkCitations([{ chunk_key: "a", stance: "supports", quote: "q", quote_verified: true }], sent, ["a"], "supported").valid).toBe(true);
    expect(checkCitations([{ chunk_key: "a", stance: "supports", quote: "q", quote_verified: false }], sent, ["a"], "supported").valid).toBe(false);
    expect(checkCitations([{ chunk_key: "b", stance: "supports" }], sent, ["a"], "supported").valid).toBe(false);
    expect(checkCitations([], sent, [], "insufficient_evidence").valid).toBe(true);
  });

  it("separates retrieval misses from reasoning errors", () => {
    expect(suggestFailure({ gold: S, pred: I, status: "ok", retrievalRecall: 0, citationValid: null, numeric: false })).toBe("retrieval_miss");
    expect(suggestFailure({ gold: S, pred: I, status: "ok", retrievalRecall: 1, citationValid: null, numeric: false })).toBe("incorrect_abstention");
    expect(suggestFailure({ gold: I, pred: S, status: "ok", retrievalRecall: null, citationValid: null, numeric: false })).toBe("failed_to_abstain");
    expect(suggestFailure({ gold: C, pred: S, status: "ok", retrievalRecall: 1, citationValid: null, numeric: true })).toBe("numerical_reasoning");
    expect(suggestFailure({ gold: C, pred: S, status: "ok", retrievalRecall: 1, citationValid: null, numeric: false })).toBe("missed_contradiction");
    expect(suggestFailure({ gold: S, pred: S, status: "ok", retrievalRecall: 1, citationValid: false, numeric: false })).toBe("invalid_citation");
    expect(suggestFailure({ gold: S, pred: null, status: "malformed", retrievalRecall: 1, citationValid: null, numeric: false })).toBe("malformed_output");
    expect(suggestFailure({ gold: S, pred: null, status: "timeout", retrievalRecall: 1, citationValid: null, numeric: false })).toBe("timeout");
  });
});

describe("benchmark summaries", () => {
  const row = (provider: "jev" | "llm_judge", g: DecisionLabel, p: DecisionLabel | null, confidence: number | null = null) => ({
    example_id: `${g}-${p}-${Math.random()}`, condition: "oracle", provider, gold: g, pred: p, status: "ok" as const, latency_ms: 100,
    est_cost_usd: 0.0001, citation_valid: true, evidence_recall: 1, failure: null, categories: ["numeric"], ambiguous: false, confidence,
  });

  it("pairs providers per example for agreement", () => {
    const rows = [
      { ...row("jev", S, S), example_id: "e1" }, { ...row("llm_judge", S, C), example_id: "e1" },
      { ...row("jev", C, C), example_id: "e2" }, { ...row("llm_judge", C, C), example_id: "e2" },
    ];
    const [s] = summarizeDecisions(rows);
    expect(s.jev!.accuracy).toBe(1);
    expect(s.llm_judge!.accuracy).toBe(0.5);
    expect(s.jev_vs_judge!.agreement).toBe(0.5);
    expect(s.jev_vs_judge!.both_correct).toBe(1);
  });

  it("reliability table and ECE", () => {
    const r = reliability([row("jev", S, S, 0.9), row("jev", S, C, 0.9)], 5);
    expect(r.bins[4].n).toBe(2);
    expect(r.bins[4].accuracy).toBe(0.5);
    expect(r.ece).toBeCloseTo(0.4);
  });
});
