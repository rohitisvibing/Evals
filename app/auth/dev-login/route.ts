import { NextResponse } from "next/server";
import { devLoginEmail, isDevLoginEnabled } from "@/lib/dev-login";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Local development only: sign in as a fixed local user without Google.
 * Creates the user on first use, then exchanges a server-generated magic-link
 * token for a normal session cookie. Returns 404 unless isDevLoginEnabled().
 */
export async function POST(request: Request) {
  if (!isDevLoginEnabled()) return new NextResponse("Not found", { status: 404 });

  const email = devLoginEmail();
  const admin = supabaseAdmin();
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) {
    return new NextResponse(`Dev login failed: ${created.error.message}`, { status: 500 });
  }
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return new NextResponse("Dev login failed: could not create a token", { status: 500 });

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error) return new NextResponse(`Dev login failed: ${error.message}`, { status: 500 });
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
