import { NextResponse } from "next/server";
import { isUuid, jsonError, requireUser } from "@/lib/http";
import { supabaseServer } from "@/lib/supabase/server";
import { getRunDetail } from "@/lib/runs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "bad_id", "Invalid run id");
  const detail = await getRunDetail(await supabaseServer(), id);
  return detail ? NextResponse.json(detail) : jsonError(404, "not_found", "Run not found");
}
