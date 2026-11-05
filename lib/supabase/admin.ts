import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS — server code and scripts only.
 * Callers must have verified the user and must scope every query explicitly.
 */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof window !== "undefined") throw new Error("supabaseAdmin() must never run in the browser");
  if (!url || !key) throw new Error("Supabase service-role configuration is missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
