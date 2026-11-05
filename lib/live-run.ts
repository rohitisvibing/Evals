import "server-only";
import { NextResponse } from "next/server";
import type { SessionUser } from "./auth";
import { limits, providerModels, versions } from "./constants";
import type { EvalTask } from "./decision/schema";
import { jsonError, throttle } from "./http";
import { compareOnEvidence, persistOutcomes, runStatusFrom } from "./pipeline";
import { generateAnswer } from "./providers/generator";
import { quotaResetsAt, releaseQuestion, reserveQuestion } from "./quota";
import { retrieve, retrievalTrace, toPassages, type Strategy } from "./retrieval";
import { supabaseAdmin } from "./supabase/admin";
import { supabaseServer } from "./supabase/server";

export type LiveInput = { mode: "claim" | "qa"; documentId: string; text: string; strategy: Strategy; k: number };

/**
 * One live run, shared by /api/evaluate (claim) and /api/ask (qa).
 *
 * Quota/failure policy:
 *  - A question is reserved atomically before any provider call.
 *  - Released if rejected before any *evaluator* runs: retrieval error, no
 *    passages, or (qa) the answer could not be generated.
 *  - Once the evaluators are called, the question counts, even if they fail.
 *  - Re-sending the same Idempotency-Key returns the existing run (no new charge).
 */
export async function runLive(user: SessionUser, idempotencyKey: string, input: LiveInput): Promise<NextResponse> {
  const { mode, documentId, text, strategy, k } = input;
  const noun = mode === "qa" ? "question" : "claim";

  if (!process.env.TYPESAFE_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return jsonError(503, "providers_not_configured", "No model providers are configured on this server. No question was counted.");
  }
  if (mode === "qa" && !process.env.OPENROUTER_API_KEY) {
    return jsonError(503, "generator_not_configured", "Answering questions needs OPENROUTER_API_KEY. No question was counted.");
  }

  const limited = await throttle(user, "evaluate", limits.perUserPerMinute, limits.perIpPerMinute);
  if (limited) return limited;

  const supabase = await supabaseServer();
  const { data: doc } = await supabase.from("documents").select("id, status, embedding_model").eq("id", documentId).maybeSingle();
  if (!doc) return jsonError(404, "not_found", "Document not found");
  if (doc.status !== "indexed") return jsonError(409, "not_indexed", "This document has not finished indexing");

  const admin = supabaseAdmin();
  const models = providerModels();
  if (strategy !== "lexical" && doc.embedding_model !== models.embedding) {
    return jsonError(409, "embedding_mismatch", `This document has no ${models.embedding} embeddings yet. Use keyword search.`);
  }

  const reservation = await reserveQuestion(admin, { userId: user.id, idempotencyKey, isAdmin: user.isAdmin, documentId, claim: text, strategy, params: { k } });
  if (!reservation.ok) {
    if (reservation.error === "quota_exceeded") {
      return jsonError(429, "quota_exceeded", `You have used ${reservation.used} of ${reservation.limit} questions this month.`, { resetsAt: quotaResetsAt().toISOString() });
    }
    return jsonError(409, "concurrent_run", "You already have a question in progress. Wait for it to finish.");
  }
  if (reservation.duplicate) return NextResponse.json({ runId: reservation.run_id, duplicate: true });

  const runId = reservation.run_id;
  const setRun = (patch: object) => admin.from("evaluation_runs").update(patch).eq("id", runId);
  await setRun({ status: "retrieving", mode });

  // ---- retrieval
  let retrieval;
  try {
    retrieval = await retrieve(supabase, { documentId, claim: text, strategy, k, embeddingModel: models.embedding });
  } catch (e) {
    await releaseQuestion(admin, runId, `retrieval_failed: ${(e as Error).message}`.slice(0, 500));
    return jsonError(502, "retrieval_failed", "Search failed. This question was not counted.");
  }
  if (retrieval.chunks.length === 0) {
    await setRun({ retrieved: [], retrieval_ms: retrieval.retrieval_ms });
    await releaseQuestion(admin, runId, "no_passages_retrieved");
    return jsonError(422, "no_evidence", `No passages matched this ${noun}. Try semantic or hybrid search. It was not counted.`);
  }
  const passages = toPassages(retrieval.chunks);
  await setRun({ retrieved: retrievalTrace(retrieval.chunks), retrieval_ms: retrieval.retrieval_ms, embedding_model: retrieval.embedding_model });

  // ---- (qa) generate the answer under evaluation
  let task: EvalTask = { kind: "claim", claim: text };
  if (mode === "qa") {
    await setRun({ status: "generating" });
    const gen = await generateAnswer(text, passages);
    await admin.from("usage_events").insert({ user_id: user.id, run_id: runId, kind: "provider_call", provider: "generator", is_admin: user.isAdmin, est_cost_usd: gen.est_cost_usd });
    const { raw, ...answerRecord } = gen;
    await setRun({ answer: { ...answerRecord, raw } });
    if (gen.status !== "ok" || !gen.text) {
      await releaseQuestion(admin, runId, `generation_failed: ${gen.error ?? gen.status}`.slice(0, 500));
      return jsonError(502, "generation_failed", `${gen.error ?? "The answer could not be generated."} This question was not counted.`, { runId });
    }
    task = { kind: "answer", question: text, answer: gen.text };
  }

  await setRun({
    status: "evaluating",
    decision_schema_version: mode === "qa" ? versions.gradeSchema : versions.decisionSchema,
    rubric_version: mode === "qa" ? versions.answerRubric : versions.rubric,
    config: {
      jev_model: models.jev, judge_model: models.judge, chunker: versions.chunker, k,
      ...(mode === "qa" ? { answer_model: models.answer, jev_prompt: versions.jevAnswerPrompt, generator_prompt: versions.generatorPrompt } : { jev_prompt: versions.jevPrompt }),
    },
  });

  // ---- evaluators (identical task + passages for both)
  const outcomes = await compareOnEvidence(task, passages);
  try {
    await persistOutcomes(admin, { id: runId, user_id: user.id, is_admin: user.isAdmin, kind: "live" }, passages, [outcomes.jev, outcomes.judge]);
    await setRun({ status: runStatusFrom([outcomes.jev, outcomes.judge]), completed_at: new Date().toISOString() });
  } catch (e) {
    await setRun({ status: "failed", error: (e as Error).message.slice(0, 500), completed_at: new Date().toISOString() });
    return jsonError(500, "persist_failed", "Results could not be saved.", { runId });
  }
  return NextResponse.json({ runId, duplicate: false });
}

export function readIdempotencyKey(request: Request): string | null {
  const idem = request.headers.get("idempotency-key") ?? "";
  return /^[A-Za-z0-9_-]{16,80}$/.test(idem) ? idem : null;
}
