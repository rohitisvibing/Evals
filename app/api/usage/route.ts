import { NextResponse } from "next/server";
import { requireUser } from "@/lib/http";
import { supabaseServer } from "@/lib/supabase/server";
import { getMonthlyUsage, quotaResetsAt } from "@/lib/quota";
import { limits } from "@/lib/constants";

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const used = await getMonthlyUsage(await supabaseServer(), user.id);
  return NextResponse.json({ used, limit: user.isAdmin ? null : limits.monthlyQuestions, exempt: user.isAdmin, resetsAt: quotaResetsAt().toISOString() });
}
