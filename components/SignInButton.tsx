"use client";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function SignInButton({ next = "/", label = "Continue with Google", small = false }: { next?: string; label?: string; small?: boolean }) {
  async function signIn() {
    const site = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
    await supabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${site}/auth/callback?next=${encodeURIComponent(next)}` },
    });
  }
  return (
    <button onClick={signIn} className={`btn btn-primary ${small ? "btn-sm" : ""}`}>
      {label}
    </button>
  );
}
