import { isDevLoginEnabled, devLoginEmail } from "@/lib/dev-login";

/** Rendered only when the local-only login bypass is enabled. */
export function DevLoginButton({ small = false }: { small?: boolean }) {
  if (!isDevLoginEnabled()) return null;
  return (
    <form action="/auth/dev-login" method="post">
      <button className={`btn ${small ? "btn-sm" : ""}`} title={`Local development only. Signs in as ${devLoginEmail()}`}>
        Skip sign-in (local)
      </button>
    </form>
  );
}
