import { NextResponse } from "next/server";
import { z } from "zod";
import { limits } from "@/lib/constants";
import { jsonError, requireUser } from "@/lib/http";
import { readIdempotencyKey, runLive } from "@/lib/live-run";
import { STRATEGIES } from "@/lib/retrieval";

export const maxDuration = 120;

const body = z.object({
  documentId: z.string().uuid(),
  claim: z.string().trim().min(5).max(limits.maxClaimChars),
  strategy: z.enum(STRATEGIES),
  k: z.number().int().min(1).max(limits.maxK).default(limits.defaultK),
});

/** Claim checking (kept for the claim benchmark; the app UI uses /api/ask). Policy in lib/live-run.ts. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const idem = readIdempotencyKey(request);
  if (!idem) return jsonError(400, "missing_idempotency_key", "Idempotency-Key header is required");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_request", "Claim must be 5–1000 characters; choose a document and strategy.");
  const { documentId, claim, strategy, k } = parsed.data;
  return runLive(user, idem, { mode: "claim", documentId, text: claim, strategy, k });
}
