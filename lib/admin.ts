// Admin determination — pure functions so they can be unit-tested.
// The allowlist comes only from server-side configuration (ADMIN_EMAILS).

export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

type AuthUserLike = { email?: string | null; email_confirmed_at?: string | null; app_metadata?: { provider?: string } };

/** Admin iff the *verified* email is on the allowlist. Never consults client-supplied flags. */
export function isAdminUser(user: AuthUserLike, allowlist: Set<string>): boolean {
  const email = user.email?.toLowerCase();
  if (!email || !allowlist.has(email)) return false;
  // Google OAuth emails are verified by Google; otherwise require confirmation.
  return Boolean(user.email_confirmed_at) || user.app_metadata?.provider === "google";
}
