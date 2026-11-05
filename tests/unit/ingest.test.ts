import { describe, expect, it } from "vitest";
import { chunkPages, splitPage, CHUNK_TARGET_CHARS } from "@/lib/ingest/chunk";
import { extractPdfPages, looksLikePdf, sha256Hex, PdfRejectedError } from "@/lib/ingest/pdf";
import { assertDim, embedTexts, EmbeddingError } from "@/lib/ingest/embed";
import { makePdf } from "../fixtures/make-pdf";

const line = (n: number) => `Revenue for segment ${n} increased to $${n * 100} million compared with the prior year period.`;

describe("PDF extraction", () => {
  it("preserves page boundaries and order", async () => {
    const pdf = makePdf([[line(1), line(2), line(3)], [line(4), line(5), line(6)], [line(7), line(8), line(9)]]);
    const { pageCount, pages } = await extractPdfPages(pdf);
    expect(pageCount).toBe(3);
    expect(pages[0]).toContain("segment 1");
    expect(pages[1]).toContain("segment 5");
    expect(pages[2]).toContain("segment 9");
    expect(pages[0]).not.toContain("segment 5");
  });

  it("rejects non-PDF bytes", async () => {
    const bytes = new TextEncoder().encode("<html>not a pdf</html>");
    expect(looksLikePdf(bytes)).toBe(false);
    await expect(extractPdfPages(bytes)).rejects.toBeInstanceOf(PdfRejectedError);
  });

  it("rejects PDFs with no extractable text (scanned-like)", async () => {
    const pdf = makePdf([[], [], []]);
    await expect(extractPdfPages(pdf)).rejects.toThrow(/No extractable text/);
  });
});

describe("chunk.v1", () => {
  it("produces stable keys and exact page references", async () => {
    const pages = ["A".repeat(50) + " first page text that is long enough", "Second page " + "word ".repeat(600), ""];
    const sha = await sha256Hex(new TextEncoder().encode("doc"));
    const a = chunkPages(sha, pages);
    const b = chunkPages(sha, pages);
    expect(a).toEqual(b);
    expect(a[0].chunk_key).toBe(`${sha.slice(0, 12)}:p1:c0`);
    expect(a.every((c) => c.page_start === c.page_end)).toBe(true);
    expect(a.filter((c) => c.page_start === 2).length).toBeGreaterThan(1);
    expect(a.some((c) => c.page_start === 3)).toBe(false); // empty page yields no chunk
    expect(new Set(a.map((c) => c.chunk_key)).size).toBe(a.length);
    expect(a.map((c) => c.chunk_index)).toEqual(a.map((_, i) => i));
  });

  it("bounds chunk size and overlaps consecutive chunks", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about operating earnings.`).join(" ");
    const parts = splitPage(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    const tail = parts[0].slice(-40);
    expect(parts[1].includes(tail.slice(tail.indexOf(" ") + 1, tail.indexOf(" ") + 20))).toBe(true);
  });
});

describe("embeddings [mock]", () => {
  const fakeFetch = (dim: number) =>
    (async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: input.map((_: string, index: number) => ({ index, embedding: Array(dim).fill(0.1) })), usage: { prompt_tokens: 10 * input.length } }));
    }) as unknown as typeof fetch;

  it("returns 1024-d vectors in input order and estimates cost", async () => {
    const r = await embedTexts(["a", "b", "c"], { apiKey: "k", model: "baai/bge-m3", fetch: fakeFetch(1024) });
    expect(r.vectors).toHaveLength(3);
    expect(r.vectors[0]).toHaveLength(1024);
    expect(r.tokens).toBe(30);
    expect(r.est_cost_usd).toBeCloseTo((30 * 0.01) / 1e6);
  });

  it("rejects embeddings whose dimension does not match the index", async () => {
    await expect(embedTexts(["a"], { apiKey: "k", fetch: fakeFetch(768) })).rejects.toThrow(/768 dimensions/);
    expect(() => assertDim(Array(1536).fill(0))).toThrow(EmbeddingError);
  });

  it("fails clearly when the key is missing", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(embedTexts(["a"])).rejects.toThrow(/OPENROUTER_API_KEY/);
    if (prev) process.env.OPENROUTER_API_KEY = prev;
  });
});
