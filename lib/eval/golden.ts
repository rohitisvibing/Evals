import { readFileSync } from "node:fs";
import { z } from "zod";
import { decisionLabel } from "../decision/schema";

export const goldenExample = z.object({
  example_id: z.string().regex(/^[a-z0-9-]+$/),
  document_key: z.string(),
  claim: z.string().min(5).max(1000),
  gold_label: decisionLabel,
  // Each group is one required piece of evidence; quotes within a group are alternatives.
  evidence_groups: z.array(z.array(z.object({ page: z.number().int().min(1), quote: z.string().min(4) }))),
  categories: z.array(z.string()),
  rationale: z.string(),
  calculation: z.string().optional(),
  check: z.object({ expr: z.string(), approx: z.number(), tol: z.number() }).optional(),
  ambiguous: z.boolean().optional(),
  is_synthetic: z.boolean().optional(),
});
export type GoldenExample = z.infer<typeof goldenExample>;

export type GoldenDoc = { document_key: string; title: string; source_url: string; sha256: string; pages: number };

export const GOLDEN_PROVENANCE =
  "Claims and labels drafted by Claude (claude-opus-5-5) from the source PDF text; quotes and arithmetic machine-verified (scripts/verify-golden.ts); not produced by Jev or the judge; pending human review.";

export function loadExamples(path: string): GoldenExample[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = goldenExample.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`line ${i + 1}: ${r.error.message}`);
      return r.data;
    });
}

export const isNumeric = (e: GoldenExample) =>
  e.categories.some((c) => ["numeric", "calculation_required"].includes(c));

/** Ensure the pinned source PDF exists locally (download + sha256 check). Node-only. */
export async function ensureGoldenPdf(doc: GoldenDoc, dir = "data/raw"): Promise<Uint8Array> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const path = `${dir}/${doc.document_key}.pdf`;
  if (!existsSync(path)) {
    const res = await fetch(doc.source_url, { headers: { "user-agent": "Mozilla/5.0 (DecisionModelObservatory)" } });
    if (!res.ok) throw new Error(`download ${doc.source_url}: HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(path));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== doc.sha256) throw new Error(`${doc.document_key}: sha256 mismatch (got ${sha}); the source document has changed`);
  return bytes;
}
