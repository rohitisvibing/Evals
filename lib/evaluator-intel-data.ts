import "server-only";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listReports, type Report } from "./reports";
import { loadExamplesCached } from "./golden-server";
import { categorize, type Annotation } from "./eval/error-categories";
import type { IntelRow } from "./eval/evaluator-intel";
import type { QaRow } from "./reports";

/** Benchmark versions the Evaluator Intelligence page can analyse. Combined views stay document-grounded. */
export const INTEL_VERSIONS = {
  "qa.v1.1": { label: "QA benchmark v1.1 (505 answers)", datasets: ["qa.v1.1"] },
  "qa.adv-v1": { label: "Adversarial set (45 cases)", datasets: ["qa.adv-v1"] },
  "qa.v1.1+adv": { label: "v1.1 + adversarial", datasets: ["qa.v1.1", "qa.adv-v1"] },
  "qa.v1": { label: "QA benchmark v1 (superseded)", datasets: ["qa.v1"] },
} as const;
export type IntelVersion = keyof typeof INTEL_VERSIONS;
export const isIntelVersion = (v: string | undefined): v is IntelVersion => !!v && v in INTEL_VERSIONS;

type ItemRecord = {
  item_id: string; question_id: string; question: string; answer_text: string; source: string; perturbation: string | null;
  truth_label: "correct" | "incorrect"; evidence_keys: string[]; category?: string; rationale?: string; fact_quote?: string;
};

const dirFor = (dataset: string) => path.join(process.cwd(), "data/golden", dataset.replace(/^qa\./, "qa-"));

function readJsonl<T>(file: string): T[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

function annotationsFor(dataset: string, items: Map<string, ItemRecord>): Record<string, Annotation> {
  // Annotations were written for qa.v1.1 answers; they apply to another version only where the answer text is identical.
  const file = path.join(process.cwd(), "data/golden/qa-v1.1/error-categories.json");
  if (!existsSync(file)) return {};
  const all = JSON.parse(readFileSync(file, "utf8")).annotations as Record<string, Annotation>;
  if (dataset === "qa.v1.1") return all;
  const v11 = new Map(readJsonl<ItemRecord>(path.join(dirFor("qa.v1.1"), "items.jsonl")).map((i) => [i.item_id, i]));
  return Object.fromEntries(Object.entries(all).filter(([id]) => items.get(id)?.answer_text === v11.get(id)?.answer_text));
}

export type IntelItem = {
  item_id: string; dataset: string; question: string; answer: string; reference: string; source: string; perturbation: string | null;
  truth: "correct" | "incorrect"; category_note: string | null; run_id: string;
};

export type IntelData = {
  version: IntelVersion;
  reports: { dataset: string; batch_id: string; created_at: string; notes: string | null }[];
  rows: (IntelRow & { dataset: string })[];
  items: Record<string, IntelItem>;
  missing: string[];
};

/** Latest real (non-mock) QA report per dataset, with per-item rows. Reports are only read. */
export async function loadIntelData(version: IntelVersion): Promise<IntelData> {
  const reports = (await listReports(false)).filter((r) => r.summary.qa);
  const golden = loadExamplesCached();
  const qaQuestions = new Map(readJsonl<{ id: string; reference: string }>(path.join(process.cwd(), "data/golden/qa-v1/questions.jsonl")).map((q) => [q.id, q]));
  const rows: IntelData["rows"] = [];
  const items: IntelData["items"] = {};
  const used: IntelData["reports"] = [];
  const missing: string[] = [];

  for (const dataset of INTEL_VERSIONS[version].datasets) {
    const report: Report | undefined = reports.find((r) => r.dataset_version === dataset && (r.summary.qa?.overall.n ?? 0) >= (dataset === "qa.adv-v1" ? 1 : 50));
    if (!report) {
      missing.push(dataset);
      continue;
    }
    used.push({ dataset, batch_id: report.batch_id, created_at: report.created_at, notes: report.notes });
    const itemMap = new Map(readJsonl<ItemRecord>(path.join(dirFor(dataset), "items.jsonl")).map((i) => [i.item_id, i]));
    const annotations = annotationsFor(dataset, itemMap);
    for (const r of report.summary.qa!.rows as QaRow[]) {
      const it = itemMap.get(r.item_id);
      if (!it) continue;
      const tags = golden.byId.get(r.question_id)?.categories ?? [];
      const cat = categorize({ item_id: r.item_id, truth: r.truth, perturbation: r.perturbation, question_tags: tags, explicit_category: it.category ?? null }, annotations);
      const key = `${dataset}|${r.item_id}`;
      rows.push({
        dataset, item_id: key, run_id: r.run_id, source: r.source, truth: r.truth, jev: r.jev, judge: r.judge,
        jev_ms: r.jev_ms, judge_ms: r.judge_ms, jev_cost: r.jev_cost, judge_cost: r.judge_cost,
        categories: cat.categories, disputed: cat.disputed,
      });
      items[key] = {
        item_id: r.item_id, dataset, question: it.question, answer: it.answer_text, source: it.source, perturbation: it.perturbation,
        reference: it.fact_quote ? `${it.rationale}` : (qaQuestions.get(r.question_id)?.reference ?? ""),
        truth: r.truth, category_note: annotations[r.item_id]?.note ?? it.rationale ?? null, run_id: r.run_id,
      };
    }
  }
  return { version, reports: used, rows, items, missing };
}
