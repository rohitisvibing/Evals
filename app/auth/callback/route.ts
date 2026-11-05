import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** OAuth PKCE callback. Only same-origin relative redirects are honoured. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL("/?auth_error=1", url.origin));
}

function safeNext(n: string | null): string {
  return n && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/workspace";
}
