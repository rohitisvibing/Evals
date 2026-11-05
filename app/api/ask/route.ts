import { NextResponse } from "next/server";
import { z } from "zod";
import { limits } from "@/lib/constants";
import { jsonError, requireUser } from "@/lib/http";
import { readIdempotencyKey, runLive } from "@/lib/live-run";
import { STRATEGIES } from "@/lib/retrieval";

export const maxDuration = 120;

const body = z.object({
  documentId: z.string().uuid(),
  question: z.string().trim().min(5).max(limits.maxQuestionChars),
  strategy: z.enum(STRATEGIES),
  k: z.number().int().min(1).max(limits.maxK).default(limits.defaultK),
});

/** Ask a question: retrieve → generate an answer → Jev and the LLM judge grade it. Policy in lib/live-run.ts. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const idem = readIdempotencyKey(request);
  if (!idem) return jsonError(400, "missing_idempotency_key", "Idempotency-Key header is required");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_request", `Questions must be 5–${limits.maxQuestionChars} characters; choose a document and search method.`);
  const { documentId, question, strategy, k } = parsed.data;
  return runLive(user, idem, { mode: "qa", documentId, text: question, strategy, k });
}
