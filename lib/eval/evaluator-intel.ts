// Evaluator Intelligence: capability by error category, disagreement analysis,
// hybrid policies and guarded findings. Pure and deterministic: everything is
// computed from stored per-item grades (no model calls).
import { bootstrapCI, latencyStats, mcnemar, mean, wilson } from "./metrics";
import { ERROR_CATEGORIES, type ErrorCategory } from "./error-categories";
import type { Grade, Truth } from "./qa-metrics";

export type IntelRow = {
  item_id: string;
  run_id?: string;
  source: string;
  truth: Truth;
  jev: Grade;
  judge: Grade;
  jev_ms: number;
  judge_ms: number;
  jev_cost: number | null;
  judge_cost: number | null;
  categories: ErrorCategory[];
  disputed?: boolean;
};

export const MIN_N = 10; // wrong answers needed before a category supports a conclusion
export const ALPHA = 0.05;

const flags = (g: Grade) => g === "incorrect";
const right = (truth: Truth, g: Grade) => g === truth;
const rate = (k: number, n: number) => (n ? k / n : NaN);

// ------------------------------------------------------------ A. capability matrix

export function capabilityMatrix(rows: IntelRow[], minN = MIN_N) {
  const scored = rows.filter((r) => !r.disputed);
  const cats = [...new Set(scored.flatMap((r) => r.categories))].sort(
    (a, b) => Object.keys(ERROR_CATEGORIES).indexOf(a) - Object.keys(ERROR_CATEGORIES).indexOf(b),
  );
  return cats.map((category) => {
    const inCat = scored.filter((r) => r.categories.includes(category));
    const wrong = inCat.filter((r) => r.truth === "incorrect");
    const correct = inCat.filter((r) => r.truth === "correct");
    const jevTP = wrong.filter((r) => flags(r.jev)).length;
    const judgeTP = wrong.filter((r) => flags(r.judge)).length;
    const both = wrong.filter((r) => flags(r.jev) && flags(r.judge)).length;
    const jevFP = correct.filter((r) => flags(r.jev)).length;
    const judgeFP = correct.filter((r) => flags(r.judge)).length;
    return {
      category,
      name: ERROR_CATEGORIES[category],
      examples: inCat.length,
      wrong: wrong.length,
      correct: correct.length,
      jev: {
        tp: jevTP, detection: rate(jevTP, wrong.length), detection_ci: wilson(jevTP, wrong.length),
        fp: jevFP, fpr: rate(jevFP, correct.length),
        accuracy: rate(inCat.filter((r) => right(r.truth, r.jev)).length, inCat.length),
      },
      judge: {
        tp: judgeTP, detection: rate(judgeTP, wrong.length), detection_ci: wilson(judgeTP, wrong.length),
        fp: judgeFP, fpr: rate(judgeFP, correct.length),
        accuracy: rate(inCat.filter((r) => right(r.truth, r.judge)).length, inCat.length),
      },
      both_catch: both,
      only_jev: jevTP - both,
      only_judge: judgeTP - both,
      neither: wrong.length - jevTP - judgeTP + both,
      mcnemar: mcnemar(wrong.map((r) => flags(r.jev)), wrong.map((r) => flags(r.judge))),
      insufficient: wrong.length < minN,
    };
  });
}
export type CapabilityRow = ReturnType<typeof capabilityMatrix>[number];

// ------------------------------------------------------------ B. disagreement

/**
 * 2x2 over wrong answers (who catches the error) or correct answers (who raises a
 * false alarm). Cells keep their item ids so examples can be inspected.
 */
export function disagreement(rows: IntelRow[], on: "wrong" | "correct" = "wrong") {
  const set = rows.filter((r) => !r.disputed && r.truth === (on === "wrong" ? "incorrect" : "correct"));
  const cell = (j: boolean, g: boolean) => set.filter((r) => flags(r.jev) === j && flags(r.judge) === g).map((r) => r.item_id);
  const cells = { both: cell(true, true), only_jev: cell(true, false), only_judge: cell(false, true), neither: cell(false, false) };
  const pairs = set.map((r) => (flags(r.jev) ? 1 : 0) - (flags(r.judge) ? 1 : 0));
  const diff = mean(pairs);
  return {
    on,
    n: set.length,
    cells,
    jev_rate: rate(cells.both.length + cells.only_jev.length, set.length),
    judge_rate: rate(cells.both.length + cells.only_judge.length, set.length),
    // Positive = Jev flags more often (catches more errors / raises more false alarms).
    difference: diff,
    difference_ci: bootstrapCI(pairs, (s) => mean(s), { iters: 4000, seed: 20261106 }),
    mcnemar: mcnemar(set.map((r) => flags(r.jev)), set.map((r) => flags(r.judge))),
  };
}

// ------------------------------------------------------------ C. hybrid policies

export type PolicyId = "jev" | "judge" | "or" | "escalate";
export type Decision = "accept" | "reject" | "escalate";

/**
 * Decisions from stored grades. "Can't tell" is not an approval: single-evaluator
 * and OR policies reject it (fail closed); escalation sends it to review.
 */
export function decide(policy: PolicyId, r: Pick<IntelRow, "jev" | "judge">): { decision: Decision; judgeCalled: boolean; jevCalled: boolean } {
  switch (policy) {
    case "jev":
      return { decision: r.jev === "correct" ? "accept" : "reject", jevCalled: true, judgeCalled: false };
    case "judge":
      return { decision: r.judge === "correct" ? "accept" : "reject", jevCalled: false, judgeCalled: true };
    case "or":
      return { decision: r.jev === "correct" && r.judge === "correct" ? "accept" : "reject", jevCalled: true, judgeCalled: true };
    case "escalate":
      if (r.jev === "incorrect") return { decision: "reject", jevCalled: true, judgeCalled: false };
      if (r.jev !== "correct") return { decision: "escalate", jevCalled: true, judgeCalled: false };
      return { decision: r.judge === "correct" ? "accept" : "escalate", jevCalled: true, judgeCalled: true };
  }
}

export const POLICY_NAME: Record<PolicyId, string> = {
  jev: "A. Jev only",
  judge: "B. LLM judge only",
  or: "C. Either flags (OR)",
  escalate: "D. Jev first, escalate disagreements",
};

export function policyStats(rows: IntelRow[], policy: PolicyId) {
  const set = rows.filter((r) => !r.disputed);
  let tp = 0, fp = 0, fn = 0, tn = 0, escalated = 0, escalatedWrong = 0;
  const costs: number[] = [];
  const latency: number[] = [];
  let costKnown = true;
  for (const r of set) {
    const d = decide(policy, r);
    const wrong = r.truth === "incorrect";
    if (d.decision === "escalate") {
      escalated++;
      if (wrong) escalatedWrong++;
    } else if (d.decision === "reject") {
      if (wrong) tp++;
      else fp++;
    } else if (wrong) fn++;
    else tn++;
    const c = (d.jevCalled ? r.jev_cost : 0) ?? null;
    const j = (d.judgeCalled ? r.judge_cost : 0) ?? null;
    if (c === null || j === null) costKnown = false;
    costs.push((c ?? 0) + (j ?? 0));
    const ms = policy === "or" ? Math.max(r.jev_ms, r.judge_ms) : (d.jevCalled ? r.jev_ms : 0) + (d.judgeCalled ? r.judge_ms : 0);
    latency.push(ms);
  }
  const n = set.length;
  const decided = n - escalated;
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn + escalatedWrong);
  // Escalation: "resolved" assumes review decides escalated items correctly (an upper bound).
  const resolvedTp = tp + escalatedWrong;
  const resolvedRecall = rate(resolvedTp, tp + fn + escalatedWrong);
  return {
    policy,
    name: POLICY_NAME[policy],
    n,
    tp, fp, fn, tn,
    wrong_total: tp + fn + escalatedWrong,
    escalated,
    escalated_wrong: escalatedWrong,
    escalation_rate: rate(escalated, n),
    accuracy: rate(tp + tn, n), // escalations count as not decided correctly
    accuracy_on_decided: rate(tp + tn, decided),
    accuracy_if_review_correct: rate(tp + tn + escalated, n),
    recall, // share of wrong answers rejected automatically
    recall_if_review_correct: resolvedRecall,
    wrong_approved: fn,
    correct_rejected: fp,
    precision,
    f1: Number.isNaN(precision) || Number.isNaN(recall) || precision + recall === 0 ? NaN : (2 * precision * recall) / (precision + recall),
    cost_per_1000: costKnown ? (costs.reduce((a, b) => a + b, 0) / Math.max(n, 1)) * 1000 : null,
    latency: latencyStats(latency),
    // A and B are measured per call; C (parallel max) and D (sequential sum) are composed from measured per-item latencies.
    latency_kind: policy === "jev" || policy === "judge" ? ("measured" as const) : ("estimated" as const),
    judge_call_rate: rate(set.filter((r) => decide(policy, r).judgeCalled).length, n),
  };
}
export type PolicyStats = ReturnType<typeof policyStats>;

export const POLICIES: PolicyId[] = ["jev", "judge", "or", "escalate"];
export const allPolicies = (rows: IntelRow[]) => POLICIES.map((p) => policyStats(rows, p));

/** Paired comparison of two automatic policies on the same items: right/wrong per item. */
export function comparePolicies(rows: IntelRow[], a: PolicyId, b: PolicyId) {
  const set = rows.filter((r) => !r.disputed);
  const ok = (p: PolicyId, r: IntelRow) => {
    const d = decide(p, r).decision;
    return d === "escalate" ? false : (d === "reject") === (r.truth === "incorrect");
  };
  const wrong = set.filter((r) => r.truth === "incorrect");
  const caught = (p: PolicyId, r: IntelRow) => decide(p, r).decision === "reject";
  return {
    accuracy: mcnemar(set.map((r) => ok(a, r)), set.map((r) => ok(b, r))),
    recall: mcnemar(wrong.map((r) => caught(a, r)), wrong.map((r) => caught(b, r))),
    false_alarms: mcnemar(
      set.filter((r) => r.truth === "correct").map((r) => caught(a, r)),
      set.filter((r) => r.truth === "correct").map((r) => caught(b, r)),
    ),
  };
}

// ------------------------------------------------------------ F. findings (guarded)

const pct = (x: number) => (Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
const p3 = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));

export type Finding = { kind: "supported" | "no-difference" | "insufficient" | "signal"; text: string };
export const SIGNAL_MIN = 3; // small-sample signals need at least this many wrong answers

export function findings(rows: IntelRow[], minN = MIN_N): { findings: Finding[]; recommendation: string } {
  const out: Finding[] = [];
  const cap = capabilityMatrix(rows, minN).filter((c) => c.category !== "unclassified");
  const dis = disagreement(rows, "wrong");

  // 1-2. Category-level differences: only with enough wrong answers AND a significant paired test.
  for (const c of cap) {
    if (c.insufficient) continue;
    if (c.mcnemar.p_value < ALPHA && c.jev.tp !== c.judge.tp) {
      const better = c.jev.tp > c.judge.tp ? "Jev" : "The LLM judge";
      out.push({ kind: "supported", text: `${better} catches more ${c.name.toLowerCase()}: Jev ${c.jev.tp}/${c.wrong}, LLM judge ${c.judge.tp}/${c.wrong} (McNemar p = ${p3(c.mcnemar.p_value)}).` });
    } else if (c.jev.detection < 0.9 && c.judge.detection < 0.9) {
      out.push({ kind: "no-difference", text: `Both miss ${c.name.toLowerCase()} at similar rates: Jev caught ${c.jev.tp}/${c.wrong}, the LLM judge ${c.judge.tp}/${c.wrong}; ${c.neither} got past both.` });
    }
  }
  // Small categories: no conclusions, but a shared blind spot (at least half got past both) is worth a labelled look.
  for (const c of cap) {
    if (!c.insufficient || c.wrong < SIGNAL_MIN || c.neither / c.wrong < 0.5) continue;
    out.push({ kind: "signal", text: `Small-sample signal, not conclusive: ${c.neither} of ${c.wrong} ${c.name.toLowerCase()} got past both evaluators.` });
  }
  const thin = cap.filter((c) => c.insufficient && c.wrong > 0).map((c) => `${c.name.toLowerCase()} (${c.wrong})`);
  if (thin.length) out.push({ kind: "insufficient", text: `Too few wrong answers to compare: ${thin.join(", ")}.` });
  if (!out.some((f) => f.kind === "supported")) {
    out.unshift({ kind: "no-difference", text: `No error category shows a statistically significant difference between Jev and the LLM judge (each needs ≥ ${minN} wrong answers and McNemar p < ${ALPHA}).` });
  }

  // 3. Complementarity.
  const oj = dis.cells.only_jev.length, og = dis.cells.only_judge.length, nb = dis.cells.neither.length, bt = dis.cells.both.length;
  if (oj >= 5 && og >= 5) {
    out.push({ kind: "supported", text: `Their strengths are partly complementary: of ${dis.n} wrong answers, only Jev caught ${oj} and only the LLM judge caught ${og}; ${nb} got past both.` });
  } else {
    out.push({ kind: "no-difference", text: `They mostly catch the same errors: both caught ${bt} of ${dis.n}, only Jev ${oj}, only the LLM judge ${og}, neither ${nb}.` });
  }

  // 4. Policies.
  const stats = Object.fromEntries(allPolicies(rows).map((s) => [s.policy, s])) as Record<PolicyId, PolicyStats>;
  const bestSingle: PolicyId = stats.jev.accuracy >= stats.judge.accuracy ? "jev" : "judge";
  const orVs = comparePolicies(rows, "or", bestSingle);
  if (orVs.recall.p_value < ALPHA && stats.or.tp > stats[bestSingle].tp) {
    out.push({ kind: "supported", text: `Combining both (OR) catches more wrong answers than ${POLICY_NAME[bestSingle].slice(3)}: ${stats.or.tp} vs ${stats[bestSingle].tp} (p = ${p3(orVs.recall.p_value)}), with ${stats.or.fp} vs ${stats[bestSingle].fp} correct answers rejected, at ${costRatio(stats.or, stats[bestSingle])} the cost.` });
  } else {
    out.push({ kind: "no-difference", text: `Combining both (OR) does not significantly improve error detection over ${POLICY_NAME[bestSingle].slice(3)}: ${stats.or.tp} vs ${stats[bestSingle].tp} wrong answers caught (p = ${p3(orVs.recall.p_value)}), with ${stats.or.fp} vs ${stats[bestSingle].fp} false rejections.` });
  }
  const esc = stats.escalate;
  out.push({
    kind: "supported",
    text: `Escalation (D) lets ${esc.wrong_approved} wrong answers through automatically (Jev alone: ${stats.jev.wrong_approved}) and sends ${pct(esc.escalation_rate)} of answers (${esc.escalated}) to review; the judge runs on ${pct(esc.judge_call_rate)} of items.`,
  });

  // Recommendation: cheapest automatic configuration not significantly worse than the best on accuracy AND recall.
  const auto: PolicyId[] = ["jev", "judge", "or"];
  const best = auto.reduce((a, b) => (stats[b].accuracy > stats[a].accuracy ? b : a));
  const nonInferior = auto.filter((p) => {
    if (p === best) return true;
    const c = comparePolicies(rows, p, best);
    const worseAcc = c.accuracy.p_value < ALPHA && stats[p].accuracy < stats[best].accuracy;
    const worseRec = c.recall.p_value < ALPHA && stats[p].tp < stats[best].tp;
    return !worseAcc && !worseRec;
  });
  const cheapest = nonInferior.reduce((a, b) => ((stats[b].cost_per_1000 ?? Infinity) < (stats[a].cost_per_1000 ?? Infinity) ? b : a));
  const recommendation =
    `${POLICY_NAME[cheapest].slice(3)} is the cheapest configuration that is not significantly worse than the best one (${POLICY_NAME[best].slice(3)}) on accuracy or error detection: ` +
    `${(stats[cheapest].accuracy * 100).toFixed(1)}% accuracy, ${stats[cheapest].tp}/${stats[cheapest].tp + stats[cheapest].fn} wrong answers caught, ` +
    `${stats[cheapest].cost_per_1000 == null ? "cost unknown" : `$${stats[cheapest].cost_per_1000.toFixed(3)} per 1,000`}, median ${Math.round(stats[cheapest].latency.p50)} ms` +
    `${stats[cheapest].latency_kind === "estimated" ? " (estimated)" : ""}.` +
    (nonInferior.length > 1 ? ` Not significantly different: ${nonInferior.filter((p) => p !== cheapest).map((p) => POLICY_NAME[p].slice(3)).join(", ")}.` : "");
  return { findings: out, recommendation };
}

function costRatio(a: PolicyStats, b: PolicyStats) {
  if (a.cost_per_1000 == null || b.cost_per_1000 == null || !b.cost_per_1000) return "unknown";
  return `${(a.cost_per_1000 / b.cost_per_1000).toFixed(1)}×`;
}
