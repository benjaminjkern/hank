import { parsePanelUrl } from "@/lib/panelUrl";
import { resolveViewedUser } from "@/server/auth/viewerScope";
import { DASHBOARD_PANEL_VIEW, loadPanelView } from "@/server/views/panelView";

export const dynamic = "force-dynamic";

// What the panel should show for a given path. The client hits this on Back /
// Forward; the shell calls loadPanelView directly for the first paint, so both
// entries into a view go through the same loader.
export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  const path = new URL(req.url).searchParams.get("path");
  if (path === null) return Response.json(DASHBOARD_PANEL_VIEW);
  return Response.json(await loadPanelView(viewedUserId, parsePanelUrl(path)));
}
