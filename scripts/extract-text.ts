// Dump per-page text of a PDF using the same extractor + chunker as the app.
// Usage: tsx scripts/extract-text.ts <pdf> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { extractPdfPages, sha256Hex } from "../lib/ingest/pdf";
import { chunkPages } from "../lib/ingest/chunk";

const [pdfPath, outDir] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(pdfPath));
const { pageCount, pages } = await extractPdfPages(bytes);
const sha = await sha256Hex(bytes);
const chunks = chunkPages(sha, pages);
mkdirSync(outDir, { recursive: true });
const name = basename(pdfPath, ".pdf");
writeFileSync(`${outDir}/${name}.pages.txt`, pages.map((p, i) => `\n===== PAGE ${i + 1} =====\n${p}`).join("\n"));
writeFileSync(`${outDir}/${name}.chunks.json`, JSON.stringify(chunks, null, 1));
console.log(JSON.stringify({ name, sha, pageCount, chunks: chunks.length, chars: pages.reduce((n, p) => n + p.length, 0) }));
