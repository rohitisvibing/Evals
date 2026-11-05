// Local-only login bypass. Enabled ONLY when all of these hold:
//  - DEV_LOGIN=1 is set explicitly
//  - Supabase points at a local stack (localhost / 127.0.0.1)
//  - not running on Vercel
// Anything else (including every hosted deployment) keeps Google-only sign-in.

type Env = Record<string, string | undefined>;

export function isDevLoginEnabled(env: Env = process.env): boolean {
  if (env.DEV_LOGIN !== "1" || env.VERCEL) return false;
  try {
    const host = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

export const devLoginEmail = (env: Env = process.env) => env.DEV_LOGIN_EMAIL?.trim() || "dev@localhost.test";
