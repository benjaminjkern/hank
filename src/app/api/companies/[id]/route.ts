import { resolveViewedUser } from "@/server/auth/viewerScope";
import { getFocusedCompanyView } from "@/server/views/getFocusedCompany";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id } = await params;
  const company = await getFocusedCompanyView(viewedUserId, id);
  if (!company) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(company);
}
