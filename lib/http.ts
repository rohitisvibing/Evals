import "server-only";
import { NextResponse } from "next/server";
import { clientIpHash, getSessionUser, type SessionUser } from "./auth";
import { checkRateLimit } from "./quota";
import { supabaseAdmin } from "./supabase/admin";

export function jsonError(status: number, code: string, message: string, extra: object = {}) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

export async function requireUser(): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  return user ?? jsonError(401, "unauthenticated", "Sign in to continue.");
}

/** Per-user and per-IP sliding-window throttles (applies to admins too). */
export async function throttle(user: SessionUser, scope: string, perUser: number, perIp: number, windowSeconds = 60) {
  const admin = supabaseAdmin();
  const ip = await clientIpHash();
  const [u, i] = await Promise.all([
    checkRateLimit(admin, `${scope}:u:${user.id}`, perUser, windowSeconds),
    checkRateLimit(admin, `${scope}:ip:${ip}`, perIp, windowSeconds),
  ]);
  if (!u || !i) return jsonError(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
  return null;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
