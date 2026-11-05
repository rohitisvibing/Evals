// Controlled wrong answers, derived deterministically from a correct reference
// answer. Each type is wrong *by construction* for its question, so its truth
// label never depends on a model. Types that cannot be guaranteed wrong (e.g.
// period or entity swaps) are deliberately not generated.
import { createHash } from "node:crypto";
import type { QaQuestion } from "./answer-check";
import { NOT_STATED } from "../providers/generator";

export type Perturbation = { type: "number_shift" | "direction_flip" | "unit_swap" | "false_abstention" | "fabricated_answer"; text: string };

const seeded = (seed: string) => parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff;

const FLIPS: [RegExp, string][] = [
  [/\brose\b/gi, "fell"], [/\bfell\b/gi, "rose"],
  [/\bincreased\b/gi, "decreased"], [/\bdecreased\b/gi, "increased"],
  [/\bincrease\b/gi, "decrease"], [/\bdecrease\b/gi, "increase"],
  [/\bup\b/gi, "down"], [/\bdown\b/gi, "up"],
  [/\bhigher\b/gi, "lower"], [/\blower\b/gi, "higher"],
  [/\babove\b/gi, "below"], [/\bbelow\b/gi, "above"],
];

/** Swap each directional word once, using placeholders so pairs don't swap back. */
export function flipDirection(text: string): string | null {
  let out = text;
  const marks: string[] = [];
  FLIPS.forEach(([re, to], i) => {
    out = out.replace(re, (m) => {
      marks[i] = m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
      return `\u0000${i}\u0000`;
    });
  });
  if (!marks.length) return null;
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => marks[Number(i)]);
}

/** Shift every occurrence of the key figure by 15–35% (beyond any tolerance), keeping formatting. */
export function shiftNumber(q: QaQuestion, text: string): string | null {
  const key = q.facts[0];
  if (!key) return null;
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  const matches = [...text.matchAll(re)].filter((m) => Number(m[0].replace(/,/g, "")) > 0);
  // Prefer the number that is the key fact (any scale), else the first number.
  const isKey = (raw: number) => [1, 1e3, 1e-3, 1e6].some((s) => Math.abs(raw * s - key.v) / Math.max(Math.abs(key.v), 1e-9) <= Math.max(key.tol, 0.01) || (key.k === "pct" && Math.abs(raw - key.v) <= key.tol));
  const targets = matches.filter((m) => isKey(Number(m[0].replace(/,/g, ""))));
  for (const m of targets.length ? targets : matches.slice(0, 1)) {
    const raw = Number(m[0].replace(/,/g, ""));
    const factor = 1 + (0.15 + seeded(q.id + m[0]) * 0.2) * (seeded(q.id) > 0.5 ? 1 : -1);
    const decimals = (m[0].split(".")[1] ?? "").length;
    const shifted = raw * factor;
    const formatted = m[0].includes(",") ? shifted.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : shifted.toFixed(decimals);
    if (formatted === m[0]) continue;
    // Replace all key occurrences so no correct copy of the figure remains.
    return targets.length
      ? text.replace(re, (x) => (isKey(Number(x.replace(/,/g, ""))) ? shiftOne(x, q.id) : x))
      : text.slice(0, m.index!) + formatted + text.slice(m.index! + m[0].length);
  }
  return null;
}

function shiftOne(x: string, seed: string): string {
  const raw = Number(x.replace(/,/g, ""));
  const factor = 1 + (0.15 + seeded(seed + x) * 0.2) * (seeded(seed) > 0.5 ? 1 : -1);
  const decimals = (x.split(".")[1] ?? "").length;
  const shifted = raw * factor;
  return x.includes(",") ? shifted.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : shifted.toFixed(decimals);
}

/** Rescale every amount (million ↔ billion, trillion → billion) so no correctly scaled copy remains. */
export function swapUnit(text: string): string | null {
  if (!/\b(trillion|billion|million)\b/i.test(text)) return null;
  const to: Record<string, string> = { million: "billion", billion: "million", trillion: "billion" };
  return text.replace(/\b(trillion|billion|million)\b/gi, (m) => to[m.toLowerCase()]);
}

const FABRICATED = [
  "It was 12.4%, according to the filing.",
  "The document reports $2.3 billion.",
  "It increased by about 8% year over year.",
];

export function perturbations(q: QaQuestion): Perturbation[] {
  if (q.type === "unanswerable") {
    return [{ type: "fabricated_answer", text: FABRICATED[Math.floor(seeded(q.id) * FABRICATED.length)] }];
  }
  const out: Perturbation[] = [{ type: "false_abstention", text: NOT_STATED }];
  const ref = q.reference;
  if (q.type === "numeric" && q.facts.length) {
    const shifted = shiftNumber(q, ref);
    if (shifted) out.push({ type: "number_shift", text: shifted });
    if (q.facts.some((f) => f.k === "usd_m")) {
      const swapped = swapUnit(ref);
      if (swapped) out.push({ type: "unit_swap", text: swapped });
    }
  }
  if ((q.type === "direction" || q.none.length) && q.any.length) {
    const flipped = flipDirection(ref);
    if (flipped && flipped !== ref) out.push({ type: "direction_flip", text: flipped });
  }
  return out;
}
