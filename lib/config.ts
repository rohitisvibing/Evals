// Server-side configuration. Never import this from client components.
import "server-only";

import { parseAdminEmails } from "./admin";

export { versions, limits } from "./constants";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const serverConfig = {
  supabaseUrl: () => env("NEXT_PUBLIC_SUPABASE_URL") ?? env("SUPABASE_URL"),
  supabaseAnonKey: () => env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => env("SUPABASE_SERVICE_ROLE_KEY"),
  adminEmails: () => parseAdminEmails(env("ADMIN_EMAILS")),
  ipHashSalt: () => env("IP_HASH_SALT") ?? "dmo-default-salt",
};

