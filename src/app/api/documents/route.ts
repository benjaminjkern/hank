import { resolveViewedUser } from "@/server/auth/viewerScope";
import { loadUserDocuments } from "@/server/views/documents";

export const dynamic = "force-dynamic";

// Read endpoint for the Documents page. Scopes by resolveViewedUser so the
// admin view-session UI (?impersonate=) sees the inspected user's documents,
// not the admin's. `readOnly` mirrors the impersonation flag so the client can
// hide every edit affordance up front (the write routes also reject it).
export async function GET(req: Request) {
  const { viewedUserId, impersonating } = await resolveViewedUser(req);
  const documents = await loadUserDocuments(viewedUserId);
  return Response.json({ ...documents, readOnly: impersonating !== null });
}
