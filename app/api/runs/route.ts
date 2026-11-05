import { NextResponse } from "next/server";
import { requireUser } from "@/lib/http";
import { supabaseServer } from "@/lib/supabase/server";
import { listRuns } from "@/lib/runs";

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ runs: await listRuns(await supabaseServer(), user.id) });
}
