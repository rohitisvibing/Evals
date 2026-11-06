import { describe, expect, it } from "vitest";
import { allPolicies, capabilityMatrix, comparePolicies, decide, disagreement, findings, policyStats, type IntelRow } from "@/lib/eval/evaluator-intel";
import type { Grade, Truth } from "@/lib/eval/qa-metrics";

let n = 0;
const row = (truth: Truth, jev: Grade, judge: Grade, cat: IntelRow["categories"] = ["numerical_mismatch"], extra: Partial<IntelRow> = {}): IntelRow => ({
  item_id: `i${n++}`, source: "perturbation", truth, jev, judge, jev_ms: 300, judge_ms: 5000, jev_cost: 0.0001, judge_cost: 0.0006, categories: cat, ...extra,
});
const times = (k: number, f: () => IntelRow) => Array.from({ length: k }, f);

describe("capability matrix", () => {
  const rows = [
    row("incorrect", "incorrect", "incorrect"), row("incorrect", "incorrect", "correct"), row("incorrect", "correct", "incorrect"),
    row("incorrect", "correct", "correct"), row("incorrect", "cannot_tell", "incorrect"),
    row("correct", "incorrect", "correct"), row("correct", "correct", "correct"),
    row("incorrect", "incorrect", "incorrect", ["unit_scale"]),
    row("incorrect", "correct", "correct", ["wrong_period"], { disputed: true }),
  ];
  const cap = capabilityMatrix(rows);
  const num = cap.find((c) => c.category === "numerical_mismatch")!;

  it("counts catches, unique catches and misses per category", () => {
    expect(num.wrong).toBe(5);
    expect(num.correct).toBe(2);
    expect(num.jev.tp).toBe(2);
    expect(num.judge.tp).toBe(3);
    expect(num.both_catch).toBe(1);
    expect(num.only_jev).toBe(1);
    expect(num.only_judge).toBe(2);
    expect(num.neither).toBe(1);
    expect(num.both_catch + num.only_jev + num.only_judge + num.neither).toBe(num.wrong);
    expect(num.jev.fp).toBe(1);
    expect(num.jev.fpr).toBeCloseTo(0.5);
    expect(num.insufficient).toBe(true);
  });

  it("excludes disputed items", () => {
    expect(cap.find((c) => c.category === "wrong_period")).toBeUndefined();
  });
});

describe("disagreement 2x2", () => {
  const rows = [
    ...times(6, () => row("incorrect", "incorrect", "incorrect")),
    ...times(3, () => row("incorrect", "incorrect", "correct")),
    ...times(1, () => row("incorrect", "correct", "incorrect")),
    ...times(2, () => row("incorrect", "correct", "correct")),
    ...times(4, () => row("correct", "correct", "correct")),
    row("correct", "incorrect", "correct"),
  ];
  it("partitions wrong answers into the four cells and sums to n", () => {
    const d = disagreement(rows, "wrong");
    expect(d.n).toBe(12);
    expect([d.cells.both.length, d.cells.only_jev.length, d.cells.only_judge.length, d.cells.neither.length]).toEqual([6, 3, 1, 2]);
    expect(d.jev_rate).toBeCloseTo(9 / 12);
    expect(d.difference).toBeCloseTo((3 - 1) / 12);
    expect(d.mcnemar.a_only).toBe(3);
    expect(d.mcnemar.b_only).toBe(1);
    expect(d.difference_ci.lo).toBeLessThanOrEqual(d.difference);
    expect(d.difference_ci.hi).toBeGreaterThanOrEqual(d.difference);
  });
  it("builds the false-alarm matrix from correct answers", () => {
    const d = disagreement(rows, "correct");
    expect(d.n).toBe(5);
    expect(d.cells.only_jev.length).toBe(1);
    expect(d.cells.neither.length).toBe(4);
  });
});

describe("hybrid policies", () => {
  it("decide() follows each policy's rules, with can't tell failing closed or escalating", () => {
    const t = (jev: Grade, judge: Grade) => ({ jev, judge });
    expect(decide("jev", t("cannot_tell", "correct")).decision).toBe("reject");
    expect(decide("judge", t("incorrect", "correct")).decision).toBe("accept");
    expect(decide("or", t("correct", "incorrect")).decision).toBe("reject");
    expect(decide("or", t("correct", "correct")).decision).toBe("accept");
    expect(decide("escalate", t("incorrect", "correct"))).toEqual({ decision: "reject", jevCalled: true, judgeCalled: false });
    expect(decide("escalate", t("correct", "correct"))).toEqual({ decision: "accept", jevCalled: true, judgeCalled: true });
    expect(decide("escalate", t("correct", "incorrect")).decision).toBe("escalate");
    expect(decide("escalate", t("cannot_tell", "correct"))).toEqual({ decision: "escalate", jevCalled: true, judgeCalled: false });
  });

  const rows = [row("incorrect", "incorrect", "correct"), row("incorrect", "correct", "incorrect"), row("incorrect", "correct", "correct"), row("correct", "correct", "incorrect"), row("correct", "correct", "correct")];
  it("computes recall, false negatives, false positives, precision and F1", () => {
    const or = policyStats(rows, "or");
    expect([or.tp, or.fn, or.fp, or.tn]).toEqual([2, 1, 1, 1]);
    expect(or.recall).toBeCloseTo(2 / 3);
    expect(or.precision).toBeCloseTo(2 / 3);
    expect(or.f1).toBeCloseTo(2 / 3);
    const jev = policyStats(rows, "jev");
    expect([jev.tp, jev.fn, jev.fp]).toEqual([1, 2, 0]);
    expect(jev.precision).toBe(1);
  });

  it("escalation: counts escalations, wrong answers sent to review and the review upper bound", () => {
    const d = policyStats(rows, "escalate");
    expect(d.escalated).toBe(2); // jev correct + judge incorrect, twice
    expect(d.escalated_wrong).toBe(1);
    expect(d.wrong_total).toBe(3);
    expect(d.fn).toBe(1); // both said correct on a wrong answer
    expect(d.accuracy).toBeCloseTo(2 / 5);
    expect(d.accuracy_if_review_correct).toBeCloseTo(4 / 5);
  });

  it("cost and latency: sum for OR, conditional judge for escalation, max for parallel", () => {
    const or = policyStats(rows, "or");
    expect(or.cost_per_1000).toBeCloseTo(0.7);
    expect(or.latency.p50).toBe(5000);
    expect(or.latency_kind).toBe("estimated");
    const d = policyStats(rows, "escalate");
    // Jev on all 5; judge only when Jev said correct (4 of 5)
    expect(d.cost_per_1000).toBeCloseTo(((5 * 0.0001 + 4 * 0.0006) / 5) * 1000);
    expect(d.judge_call_rate).toBeCloseTo(0.8);
    expect(policyStats(rows, "jev").latency_kind).toBe("measured");
  });

  it("returns null cost when any needed cost is unknown, and NaN F1 with no positives", () => {
    expect(policyStats([row("correct", "correct", "correct", undefined, { jev_cost: null })], "jev").cost_per_1000).toBeNull();
    expect(Number.isNaN(policyStats([row("correct", "correct", "correct")], "jev").f1)).toBe(true);
  });
});

describe("findings guards", () => {
  it("makes no category claim with too few wrong answers or without significance", () => {
    const rows = [...times(5, () => row("incorrect", "incorrect", "correct")), ...times(5, () => row("correct", "correct", "correct"))];
    const f = findings(rows);
    expect(f.findings.some((x) => x.kind === "supported" && /catches more/.test(x.text))).toBe(false);
    expect(f.findings.some((x) => x.kind === "insufficient")).toBe(true);
  });

  it("claims a category difference only when n ≥ 10 and McNemar p < 0.05", () => {
    const rows = [...times(12, () => row("incorrect", "incorrect", "correct")), ...times(8, () => row("incorrect", "incorrect", "incorrect")), ...times(10, () => row("correct", "correct", "correct"))];
    const f = findings(rows);
    expect(f.findings.some((x) => x.kind === "supported" && /Jev catches more numerical mismatch/.test(x.text))).toBe(true);
  });

  it("only calls them complementary with ≥ 5 unique catches each", () => {
    const few = findings([...times(4, () => row("incorrect", "incorrect", "correct")), ...times(4, () => row("incorrect", "correct", "incorrect"))]);
    expect(few.findings.some((x) => /complementary/.test(x.text))).toBe(false);
    const many = findings([...times(6, () => row("incorrect", "incorrect", "correct")), ...times(6, () => row("incorrect", "correct", "incorrect"))]);
    expect(many.findings.some((x) => /complementary/.test(x.text))).toBe(true);
  });

  it("flags shared blind spots in small categories only as labelled signals", () => {
    const f = findings([...times(3, () => row("incorrect", "correct", "correct", ["arithmetic"])), ...times(20, () => row("correct", "correct", "correct"))]);
    expect(f.findings.some((x) => x.kind === "signal" && /not conclusive/.test(x.text))).toBe(true);
  });

  it("recommends the cheapest non-inferior configuration, which can be Jev alone", () => {
    const rows = [...times(30, () => row("incorrect", "incorrect", "incorrect")), ...times(30, () => row("correct", "correct", "correct")), row("incorrect", "correct", "incorrect")];
    expect(comparePolicies(rows, "jev", "or").recall.p_value).toBeGreaterThan(0.05);
    expect(findings(rows).recommendation).toMatch(/^Jev only is the cheapest/);
    expect(allPolicies(rows)).toHaveLength(4);
  });
});
