import { resolveViewedUser } from "@/server/auth/viewerScope";
import { loadAnalytics } from "@/server/views/analytics";

export const dynamic = "force-dynamic";

// Read endpoint for the Analytics page. Scopes by resolveViewedUser so the
// admin view-session UI (?impersonate=) sees the inspected user's analytics,
// not the admin's — same convention as the dashboard / documents routes.
export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  const data = await loadAnalytics(viewedUserId);
  return Response.json(data);
}
