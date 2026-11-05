import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { isAdminUser } from "./admin";
import { serverConfig } from "./config";
import { supabaseServer } from "./supabase/server";

export type SessionUser = { id: string; email: string | null; isAdmin: boolean };

/**
 * Verify the session with the Supabase Auth server (getUser, not getSession,
 * so a forged cookie is rejected). Admin status comes only from the
 * server-side ADMIN_EMAILS allowlist matched against a *verified* email.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null, isAdmin: isAdminUser(data.user, serverConfig.adminEmails()) };
}

export async function clientIpHash(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
  return createHash("sha256").update(serverConfig.ipHashSalt() + ip).digest("hex").slice(0, 32);
}
