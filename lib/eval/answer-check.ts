// Deterministic truth for generated answers: compare an answer against a
// question's reference facts. Never consults Jev or the judge. Anything it
// cannot decide confidently is returned as `needs_review` for a human.

export type Fact = { k: "pct" | "usd_m" | "num" | "ratio"; v: number; tol: number };
export type QaQuestion = {
  id: string;
  question: string;
  reference: string;
  type: "numeric" | "direction" | "text" | "unanswerable";
  facts: Fact[];
  /** Every group must match (any term in the group, case-insensitive substring). */
  any: string[][];
  /** Wording that, without the required wording, marks the answer wrong. */
  none: string[];
};

export type CheckResult = { verdict: "correct" | "incorrect" | "needs_review"; reason: string };

const DECLINE = /(does not|doesn't|do not|did not)\s+(say|state|specify|provide|mention|disclose|include|contain|give|report)|not\s+(stated|provided|disclosed|mentioned|specified|available|given|reported)|no (information|data|figure|mention)|cannot be determined|not (possible|able) to determine|unable to determine/i;

export function isDecline(text: string, abstained = false): boolean {
  return abstained || DECLINE.test(text);
}

type Extracted = { k: Fact["k"]; v: number };

/** Pull numbers with their kind. Dollar/scale amounts are normalized to $ millions. */
export function extractNumbers(text: string): Extracted[] {
  const out: Extracted[] = [];
  const t = text.replace(/[−–]/g, "-");
  const re = /(\$|¥|€)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|percent|percentage points?|pp\b|x\b|times\b|trillion|billion|million|thousand|bn\b|mn\b|m\b|b\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const currency = m[1];
    const raw = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(raw)) continue;
    const unit = (m[3] ?? "").toLowerCase();
    if (unit === "%" || unit.startsWith("percent") || unit === "pp") {
      out.push({ k: "pct", v: raw });
    } else if (unit === "x" || unit === "times") {
      out.push({ k: "ratio", v: raw });
    } else if (["trillion", "billion", "bn", "b", "million", "mn", "m", "thousand"].includes(unit) || currency) {
      const scale = unit === "trillion" ? 1e6 : unit === "billion" || unit === "bn" || unit === "b" ? 1e3 : unit === "thousand" ? 1e-3 : 1;
      out.push({ k: "usd_m", v: raw * scale });
      // A bare "$30,796" in a filing is already in millions; also try the literal value as a plain number.
      if (!unit) out.push({ k: "num", v: raw });
    } else {
      out.push({ k: "num", v: raw });
    }
  }
  return out;
}

function within(f: Fact, x: number): boolean {
  if (f.k === "pct") return Math.abs(Math.abs(x) - Math.abs(f.v)) <= f.tol;
  const denom = Math.max(Math.abs(f.v), 1e-9);
  return Math.abs(Math.abs(x) - Math.abs(f.v)) / denom <= f.tol;
}

export function factSatisfied(f: Fact, nums: Extracted[]): boolean {
  // usd amounts may also be written as plain numbers next to "million" elsewhere in the sentence.
  const kinds: Fact["k"][] = f.k === "usd_m" ? ["usd_m", "num"] : f.k === "num" ? ["num", "usd_m"] : [f.k];
  return nums.some((n) => kinds.includes(n.k) && within(f, n.v));
}

const has = (text: string, term: string) => text.includes(term.toLowerCase());

export function checkAnswer(q: QaQuestion, answer: { text: string; abstained?: boolean }): CheckResult {
  const text = answer.text.toLowerCase();
  const declined = isDecline(answer.text, answer.abstained);

  if (q.type === "unanswerable") {
    return declined
      ? { verdict: "correct", reason: "Declined; the document does not contain the answer." }
      : { verdict: "incorrect", reason: "Gave an answer although the document does not contain one." };
  }
  if (declined) return { verdict: "incorrect", reason: "Declined although the document contains the answer." };

  const nums = extractNumbers(answer.text);
  const missingFacts = q.facts.filter((f) => !factSatisfied(f, nums));
  const missingGroups = q.any.filter((g) => !g.some((term) => has(text, term)));
  const forbidden = q.none.filter((term) => has(text, term));

  if (!missingFacts.length && !missingGroups.length && !forbidden.length) {
    return { verdict: "correct", reason: "All reference facts present." };
  }
  // Contradiction signals: forbidden wording without the required wording,
  // or a number of the right kind that matches no reference value.
  if (forbidden.length && missingGroups.length) {
    return { verdict: "incorrect", reason: `States "${forbidden[0]}" and lacks the expected wording.` };
  }
  const conflicting = missingFacts.filter((f) => nums.some((n) => n.k === f.k) && !nums.some((n) => n.k === f.k && within(f, n.v)));
  if (conflicting.length && conflicting.length === missingFacts.length && q.facts.length > 0) {
    return { verdict: "incorrect", reason: `Gives a ${conflicting[0].k} figure that does not match ${conflicting[0].v}.` };
  }
  return { verdict: "needs_review", reason: [missingFacts.length && "facts not found", missingGroups.length && "expected wording not found", forbidden.length && "mixed wording"].filter(Boolean).join("; ") };
}
