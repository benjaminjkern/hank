import { resolveViewedUser } from "@/server/platform/admin/viewerScope";
import { loadDashboard } from "@/server/views/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  return Response.json(await loadDashboard(viewedUserId));
}
