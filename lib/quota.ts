import type { SupabaseClient } from "@supabase/supabase-js";
import { limits } from "./constants";

export type Reservation =
  | { ok: true; duplicate: false; run_id: string; used: number; limit: number; is_admin: boolean }
  | { ok: true; duplicate: true; run_id: string; status: string }
  | { ok: false; error: "quota_exceeded"; used: number; limit: number }
  | { ok: false; error: "concurrent_run" };

/** Atomic reservation via the service-role-only `reserve_question` RPC. */
export async function reserveQuestion(
  admin: SupabaseClient,
  args: { userId: string; idempotencyKey: string; isAdmin: boolean; documentId: string; claim: string; strategy: string; params: object },
): Promise<Reservation> {
  const { data, error } = await admin.rpc("reserve_question", {
    p_user_id: args.userId,
    p_idempotency_key: args.idempotencyKey,
    p_is_admin: args.isAdmin,
    p_limit: limits.monthlyQuestions,
    p_document_id: args.documentId,
    p_claim: args.claim,
    p_strategy: args.strategy,
    p_params: args.params,
  });
  if (error) throw new Error(`reserve_question failed: ${error.message}`);
  return data as Reservation;
}

export async function releaseQuestion(admin: SupabaseClient, runId: string, reason: string): Promise<boolean> {
  const { data, error } = await admin.rpc("release_question", { p_run_id: runId, p_reason: reason });
  if (error) throw new Error(`release_question failed: ${error.message}`);
  return Boolean(data);
}

export async function checkRateLimit(admin: SupabaseClient, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc("check_rate_limit", { p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds });
  if (error) throw new Error(`check_rate_limit failed: ${error.message}`);
  return Boolean(data);
}

/** First instant of the next UTC month. */
export function quotaResetsAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function currentMonthKey(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function getMonthlyUsage(client: SupabaseClient, userId: string): Promise<number> {
  const { data } = await client
    .from("monthly_usage")
    .select("used")
    .eq("user_id", userId)
    .eq("month", currentMonthKey())
    .maybeSingle();
  return data?.used ?? 0;
}
