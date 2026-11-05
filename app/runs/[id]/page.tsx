import { redirect } from "next/navigation";

/** Deep links (e.g. from the benchmark failure explorer) open inside the single-page app. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/?tab=evaluations&run=${encodeURIComponent(id)}`);
}
