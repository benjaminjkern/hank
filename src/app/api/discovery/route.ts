// The discovery list the panel renders. Read-only; every write goes through
// ./edit.

import { resolveViewedUser } from "@/server/auth/viewerScope";
import { loadDiscoveryList } from "@/server/views/discoveryList";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  return Response.json(await loadDiscoveryList(viewedUserId));
}
