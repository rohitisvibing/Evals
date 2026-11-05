// Scoring the evaluators in QA mode. Truth = is the generated answer actually correct?
// Positive class = an INCORRECT answer: catching wrong answers is the evaluator's job.
import type { GradeLabel } from "../decision/schema";
import { mcnemar, wilson } from "./metrics";

export type Truth = "correct" | "incorrect";
export type Grade = GradeLabel | null; // null = the evaluator produced no grade (error/timeout/...)

export type GradedRow = { truth: Truth; grade: Grade };

export const isRight = (truth: Truth, grade: Grade) => grade === truth;

export function evaluatorStats(rows: GradedRow[]) {
  const n = rows.length;
  const right = rows.filter((r) => isRight(r.truth, r.grade)).length;
  const wrongAnswers = rows.filter((r) => r.truth === "incorrect");
  const correctAnswers = rows.filter((r) => r.truth === "correct");
  const caught = wrongAnswers.filter((r) => r.grade === "incorrect").length;
  const falseAlarms = correctAnswers.filter((r) => r.grade === "incorrect").length;
  const flagged = rows.filter((r) => r.grade === "incorrect").length;
  return {
    n,
    right,
    accuracy: n ? right / n : NaN,
    accuracy_ci: wilson(right, n),
    wrong_answers: wrongAnswers.length,
    caught,
    catch_rate: wrongAnswers.length ? caught / wrongAnswers.length : NaN,
    catch_ci: wilson(caught, wrongAnswers.length),
    // Wrong answers the evaluator approved: the most damaging miss.
    approved_wrong: wrongAnswers.filter((r) => r.grade === "correct").length,
    correct_answers: correctAnswers.length,
    false_alarms: falseAlarms,
    false_alarm_rate: correctAnswers.length ? falseAlarms / correctAnswers.length : NaN,
    precision_incorrect: flagged ? caught / flagged : NaN,
    cannot_tell: rows.filter((r) => r.grade === "cannot_tell").length,
    cannot_tell_rate: n ? rows.filter((r) => r.grade === "cannot_tell").length / n : NaN,
    no_grade: rows.filter((r) => r.grade === null).length,
    kappa_vs_truth: binaryKappa(rows),
  };
}
export type EvaluatorStats = ReturnType<typeof evaluatorStats>;

/** Cohen's kappa between truth and grade, over rows with a definite grade. */
export function binaryKappa(rows: GradedRow[]): number {
  const d = rows.filter((r) => r.grade === "correct" || r.grade === "incorrect");
  const n = d.length;
  if (!n) return NaN;
  const po = d.filter((r) => r.grade === r.truth).length / n;
  const pt = d.filter((r) => r.truth === "correct").length / n;
  const pg = d.filter((r) => r.grade === "correct").length / n;
  const pe = pt * pg + (1 - pt) * (1 - pg);
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}

export type PairRow = { truth: Truth; jev: Grade; judge: Grade };

export function headToHead(rows: PairRow[]) {
  const jev = evaluatorStats(rows.map((r) => ({ truth: r.truth, grade: r.jev })));
  const judge = evaluatorStats(rows.map((r) => ({ truth: r.truth, grade: r.judge })));
  const test = mcnemar(rows.map((r) => isRight(r.truth, r.jev)), rows.map((r) => isRight(r.truth, r.judge)));
  return { n: rows.length, jev, judge, mcnemar: test };
}
export type HeadToHead = ReturnType<typeof headToHead>;

export const MIN_N_FOR_WINNER = 10;

/** Plain-language verdict. Names a winner only when the paired difference is significant. */
export function qaHeadline(h: HeadToHead, alpha = 0.05): { winner: "jev" | "llm_judge" | null; sentence: string; detail: string } {
  const pct = (x: number) => (Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
  const detail =
    `Wrong answers caught: Jev ${h.jev.caught} of ${h.jev.wrong_answers}, LLM judge ${h.judge.caught} of ${h.judge.wrong_answers}. ` +
    `False alarms on correct answers: Jev ${h.jev.false_alarms}, LLM judge ${h.judge.false_alarms}.`;
  if (h.n === 0) return { winner: null, sentence: "No graded answers yet.", detail: "" };
  const base = `Jev graded ${pct(h.jev.accuracy)} of ${h.n} answers correctly; the LLM judge ${pct(h.judge.accuracy)}.`;
  if (h.n < MIN_N_FOR_WINNER) return { winner: null, sentence: `${base} Too few answers to call a winner.`, detail };
  const p = h.mcnemar.p_value;
  if (p >= alpha || h.jev.right === h.judge.right) {
    return { winner: null, sentence: `${base} No clear winner yet (McNemar p = ${p.toFixed(2)}).`, detail };
  }
  const winner = h.jev.right > h.judge.right ? "jev" : "llm_judge";
  const name = winner === "jev" ? "Jev" : "The LLM judge";
  return { winner, sentence: `${name} is the more reliable grader. ${base} The difference is statistically significant (McNemar p = ${p < 0.001 ? "< 0.001" : p.toFixed(3)}).`, detail };
}

/** Group paired rows by a key (e.g. mistake type) and compute head-to-head stats per group. */
export function headToHeadBy<T extends PairRow>(rows: T[], key: (r: T) => string) {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].map(([group, rs]) => ({ group, ...headToHead(rs) }));
}

/**
 * Layer separation for the headline: evaluators are compared only where both saw the
 * labelled evidence. Hybrid-search items mix in retrieval misses, so they are reported
 * separately as end-to-end.
 */
export function splitByEvidence<T extends PairRow & { source: string }>(rows: T[]) {
  const labelled = rows.filter((r) => r.source !== "rag_hybrid");
  const endToEnd = rows.filter((r) => r.source === "rag_hybrid");
  return { labelled: headToHead(labelled), endToEnd: headToHead(endToEnd) };
}

/** Plain-language speed/cost comparison, generated from measured medians and means. */
export function tradeoffSentence(lat: { jev: number; judge: number }, cost: { jev: number | null; judge: number | null }): string | null {
  if (!lat.jev || !lat.judge) return null;
  const faster = lat.jev < lat.judge ? "Jev" : "The LLM judge";
  const speedup = Math.max(lat.jev, lat.judge) / Math.min(lat.jev, lat.judge);
  const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
  let out = `${faster} is ${speedup >= 1.95 ? `${Math.round(speedup)}×` : `${speedup.toFixed(1)}×`} faster (median ${secs(Math.min(lat.jev, lat.judge))} vs ${secs(Math.max(lat.jev, lat.judge))} per answer)`;
  if (cost.jev && cost.judge) {
    const cheaper = cost.jev < cost.judge ? "Jev" : "the LLM judge";
    const ratio = Math.max(cost.jev, cost.judge) / Math.min(cost.jev, cost.judge);
    out += ` and ${cheaper === "Jev" && faster === "Jev" ? "" : `${cheaper} is `}${ratio.toFixed(1)}× cheaper`;
  }
  return out + ".";
}
