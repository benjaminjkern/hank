import { resolveViewedUser } from "@/server/auth/viewerScope";
import { getFocusedOpportunityView } from "@/server/views/getFocusedOpportunity";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id } = await params;
  const opportunity = await getFocusedOpportunityView(viewedUserId, id);
  if (!opportunity)
    return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(opportunity);
}
