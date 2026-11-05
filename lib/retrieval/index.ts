import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvidencePassage } from "../decision/schema";
import { embedTexts, toPgVector } from "../ingest/embed";

export const STRATEGIES = ["lexical", "vector", "hybrid"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type RetrievedChunk = {
  chunk_key: string;
  page_start: number;
  page_end: number;
  content: string;
  score: number;
  rank: number;
  lexical_rank?: number | null;
  vector_rank?: number | null;
};

export type RetrievalOutput = {
  strategy: Strategy;
  k: number;
  chunks: RetrievedChunk[];
  retrieval_ms: number;
  embedding_model: string | null;
  embedding_cost_usd: number | null;
};

type Deps = { embed?: typeof embedTexts };

/**
 * Retrieve evidence for a claim from one document. Pass the *user-scoped*
 * client in request handlers so RLS restricts results to documents the caller
 * may read (the RPCs are SECURITY INVOKER).
 */
export async function retrieve(
  client: SupabaseClient,
  args: { documentId: string; claim: string; strategy: Strategy; k: number; embeddingModel: string },
  deps: Deps = {},
): Promise<RetrievalOutput> {
  const embed = deps.embed ?? embedTexts;
  const started = performance.now();
  let embeddingCost: number | null = null;
  let queryVec: string | null = null;

  if (args.strategy !== "lexical") {
    const e = await embed([args.claim], { model: args.embeddingModel });
    queryVec = toPgVector(e.vectors[0]);
    embeddingCost = e.est_cost_usd;
  }

  let res;
  if (args.strategy === "lexical") {
    res = await client.rpc("match_chunks_lexical", { p_document_id: args.documentId, p_query: args.claim, p_k: args.k });
  } else if (args.strategy === "vector") {
    res = await client.rpc("match_chunks_vector", {
      p_document_id: args.documentId,
      p_query_embedding: queryVec,
      p_embedding_model: args.embeddingModel,
      p_k: args.k,
    });
  } else {
    res = await client.rpc("match_chunks_hybrid", {
      p_document_id: args.documentId,
      p_query: args.claim,
      p_query_embedding: queryVec,
      p_embedding_model: args.embeddingModel,
      p_k: args.k,
    });
  }
  if (res.error) throw new Error(`Retrieval failed: ${res.error.message}`);

  const rows = (res.data ?? []) as Omit<RetrievedChunk, "rank">[];
  return {
    strategy: args.strategy,
    k: args.k,
    chunks: rows.map((r, i) => ({ ...r, rank: i + 1 })),
    retrieval_ms: Math.round(performance.now() - started),
    embedding_model: args.strategy === "lexical" ? null : args.embeddingModel,
    embedding_cost_usd: embeddingCost,
  };
}

/** Turn retrieved chunks into evaluator passages with prompt-local ids E1..En. */
export function toPassages(chunks: Pick<RetrievedChunk, "chunk_key" | "page_start" | "page_end" | "content">[]): EvidencePassage[] {
  return chunks.map((c, i) => ({
    id: `E${i + 1}`,
    chunk_key: c.chunk_key,
    page_start: c.page_start,
    page_end: c.page_end,
    text: c.content,
  }));
}

/** Trace-friendly summary (no full text). */
export function retrievalTrace(chunks: RetrievedChunk[]) {
  return chunks.map(({ chunk_key, page_start, page_end, score, rank, lexical_rank, vector_rank }) => ({
    chunk_key,
    page_start,
    page_end,
    score,
    rank,
    ...(lexical_rank !== undefined ? { lexical_rank, vector_rank } : {}),
  }));
}
