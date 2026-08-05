import { resolveViewedUser } from "@/server/auth/viewerScope";
import { getFocusedJobView } from "@/server/views/getFocusedJob";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id } = await params;
  const job = await getFocusedJobView(viewedUserId, id);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(job);
}
