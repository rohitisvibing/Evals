import "server-only";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadExamples, type GoldenExample } from "./eval/golden";
import { versions } from "./constants";

let cache: { version: string; items: GoldenExample[]; byId: Map<string, GoldenExample>; counts: Record<string, number> } | null = null;

/** The committed golden set (public benchmark data; claims only reference public filings). */
export function loadExamplesCached() {
  if (!cache) {
    const items = loadExamples(path.join(process.cwd(), "data/golden/v1/examples.jsonl"));
    const counts = { supported: 0, contradicted: 0, insufficient_evidence: 0 } as Record<string, number>;
    items.forEach((e) => counts[e.gold_label]++);
    cache = { version: versions.dataset, items, byId: new Map(items.map((e) => [e.example_id, e])), counts };
  }
  return cache;
}

type QaItemLite = { item_id: string; question: string; answer_text: string; source: string; perturbation: string | null; truth_label: string };
let qaCache: Map<string, QaItemLite> | null = null;

/** Frozen QA candidate answers (public benchmark data). */
export function loadQaItemsCached(): Map<string, QaItemLite> {
  if (!qaCache) {
    const file = path.join(process.cwd(), "data/golden/qa-v1/items.jsonl");
    qaCache = new Map(
      existsSync(file)
        ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const i = JSON.parse(l) as QaItemLite; return [i.item_id, i] as const; })
        : [],
    );
  }
  return qaCache;
}
