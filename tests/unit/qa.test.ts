import { describe, expect, it } from "vitest";
import { checkAnswer, extractNumbers, isDecline, type QaQuestion } from "@/lib/eval/answer-check";
import { flipDirection, perturbations, shiftNumber, swapUnit } from "@/lib/eval/perturb";
import { binaryKappa, evaluatorStats, headToHead, qaHeadline } from "@/lib/eval/qa-metrics";

const numericQ: QaQuestion = {
  id: "t-1", question: "By what percentage did net earnings change?", reference: "They rose about 17.3%, from $26,251 million to $30,796 million.",
  type: "numeric", facts: [{ k: "pct", v: 17.3, tol: 0.3 }], any: [["rose", "increas", "grew"]], none: ["fell", "decreas"],
};
const amountQ: QaQuestion = { id: "t-2", question: "What were total revenues?", reference: "$277,212 million (about $277.2 billion).", type: "numeric", facts: [{ k: "usd_m", v: 277212, tol: 0.005 }], any: [], none: [] };
const unanswerable: QaQuestion = { id: "t-3", question: "What was headcount growth?", reference: "Not stated.", type: "unanswerable", facts: [], any: [], none: [] };

describe("answer checker", () => {
  it("parses percentages, scaled dollar amounts and plain numbers", () => {
    expect(extractNumbers("rose 17.3% to $30.8 billion; 2,508 cars")).toEqual(
      expect.arrayContaining([{ k: "pct", v: 17.3 }, { k: "usd_m", v: 30800 }, { k: "num", v: 2508 }]),
    );
    expect(extractNumbers("$1.23 trillion")).toEqual([{ k: "usd_m", v: 1230000 }]);
  });

  it("accepts the same figure written at a different scale", () => {
    expect(checkAnswer(amountQ, { text: "Revenues were $277.2 billion." }).verdict).toBe("correct");
    expect(checkAnswer(amountQ, { text: "Revenues were $277,212 million." }).verdict).toBe("correct");
  });

  it("marks a wrong figure or a wrong direction incorrect", () => {
    expect(checkAnswer(amountQ, { text: "Revenues were $310.0 billion." }).verdict).toBe("incorrect");
    expect(checkAnswer(numericQ, { text: "They rose about 21.4%." }).verdict).toBe("incorrect");
    expect(checkAnswer(numericQ, { text: "They fell, by about 17.3%." }).verdict).toBe("incorrect"); // right number, wrong direction
    expect(checkAnswer(numericQ, { text: "They rose 17.3% after an earlier decrease." }).verdict).toBe("needs_review"); // mixed wording
  });

  it("treats declining correctly for answerable and unanswerable questions", () => {
    expect(isDecline("The document does not say.")).toBe(true);
    expect(isDecline("The exact amount is not specified.")).toBe(true);
    expect(checkAnswer(unanswerable, { text: "The document does not say.", abstained: true }).verdict).toBe("correct");
    expect(checkAnswer(unanswerable, { text: "It grew 3%." }).verdict).toBe("incorrect");
    expect(checkAnswer(amountQ, { text: "The document does not say." }).verdict).toBe("incorrect");
  });

  it("returns needs_review rather than guessing", () => {
    expect(checkAnswer(numericQ, { text: "Earnings went up substantially." }).verdict).toBe("needs_review");
  });
});

describe("constructed mistakes", () => {
  it("are deterministic", () => {
    expect(perturbations(numericQ)).toEqual(perturbations(numericQ));
  });

  it("are never graded correct by the checker", () => {
    for (const q of [numericQ, amountQ, unanswerable]) {
      for (const p of perturbations(q)) {
        expect(checkAnswer(q, { text: p.text, abstained: p.type === "false_abstention" }).verdict, `${q.id} ${p.type}: ${p.text}`).not.toBe("correct");
      }
    }
  });

  it("shift every copy of the key figure and swap every unit", () => {
    const shifted = shiftNumber(numericQ, numericQ.reference)!;
    expect(shifted).not.toContain("17.3%");
    expect(swapUnit("$277,212 million (about $277.2 billion)")).toBe("$277,212 billion (about $277.2 million)");
    expect(swapUnit("about $1.23 trillion")).toBe("about $1.23 billion");
  });

  it("flip direction words without swapping them back", () => {
    expect(flipDirection("They rose, then fell.")).toBe("They fell, then rose.");
    expect(flipDirection("No change.")).toBeNull();
  });

  it("include a fabricated answer for unanswerable questions and a false abstention otherwise", () => {
    expect(perturbations(unanswerable).map((p) => p.type)).toEqual(["fabricated_answer"]);
    expect(perturbations(numericQ).map((p) => p.type)).toContain("false_abstention");
  });
});

describe("QA metrics", () => {
  const rows = [
    { truth: "incorrect", grade: "incorrect" },
    { truth: "incorrect", grade: "correct" },
    { truth: "incorrect", grade: "cannot_tell" },
    { truth: "correct", grade: "correct" },
    { truth: "correct", grade: "incorrect" },
    { truth: "correct", grade: null },
  ] as const;

  it("computes catch rate, approvals of wrong answers and false alarms", () => {
    const s = evaluatorStats(rows.map((r) => ({ ...r })));
    expect(s.accuracy).toBeCloseTo(2 / 6);
    expect(s.caught).toBe(1);
    expect(s.catch_rate).toBeCloseTo(1 / 3);
    expect(s.approved_wrong).toBe(1);
    expect(s.false_alarms).toBe(1);
    expect(s.false_alarm_rate).toBeCloseTo(1 / 3);
    expect(s.cannot_tell).toBe(1);
    expect(s.no_grade).toBe(1);
  });

  it("kappa is 1 for perfect grading and ~0 for chance", () => {
    expect(binaryKappa([{ truth: "correct", grade: "correct" }, { truth: "incorrect", grade: "incorrect" }])).toBe(1);
    expect(binaryKappa([{ truth: "correct", grade: "correct" }, { truth: "incorrect", grade: "correct" }])).toBeCloseTo(0);
  });

  it("only names a winner when the difference is significant", () => {
    const pair = (n: number, jevRight: boolean, judgeRight: boolean) =>
      Array.from({ length: n }, () => ({ truth: "incorrect" as const, jev: jevRight ? ("incorrect" as const) : ("correct" as const), judge: judgeRight ? ("incorrect" as const) : ("correct" as const) }));
    const clear = headToHead([...pair(20, true, false), ...pair(20, true, true)]);
    expect(qaHeadline(clear).winner).toBe("jev");
    expect(qaHeadline(clear).sentence).toMatch(/Jev is the more reliable grader/);
    const close = headToHead([...pair(3, true, false), ...pair(2, false, true), ...pair(20, true, true)]);
    expect(qaHeadline(close).winner).toBeNull();
    expect(qaHeadline(close).sentence).toMatch(/No clear winner/);
    expect(qaHeadline(headToHead(pair(4, true, false))).sentence).toMatch(/Too few answers/);
  });
});

describe("layer separation", () => {
  it("compares evaluators on labelled-evidence items and reports hybrid search separately", async () => {
    const { splitByEvidence } = await import("@/lib/eval/qa-metrics");
    const rows = [
      { source: "reference", truth: "correct" as const, jev: "correct" as const, judge: "correct" as const },
      { source: "perturbation", truth: "incorrect" as const, jev: "incorrect" as const, judge: "correct" as const },
      { source: "rag_hybrid", truth: "incorrect" as const, jev: "correct" as const, judge: "correct" as const },
    ];
    const s = splitByEvidence(rows);
    expect(s.labelled.n).toBe(2);
    expect(s.labelled.jev.accuracy).toBe(1);
    expect(s.endToEnd.n).toBe(1);
    expect(s.endToEnd.jev.accuracy).toBe(0);
  });
});

describe("trade-off sentence", () => {
  it("states speed and cost ratios from measured values", async () => {
    const { tradeoffSentence } = await import("@/lib/eval/qa-metrics");
    expect(tradeoffSentence({ jev: 324, judge: 6610 }, { jev: 0.000126, judge: 0.000617 })).toBe("Jev is 20× faster (median 324 ms vs 6.6 s per answer) and 4.9× cheaper.");
    expect(tradeoffSentence({ jev: 0, judge: 10 }, { jev: null, judge: null })).toBeNull();
  });
});
