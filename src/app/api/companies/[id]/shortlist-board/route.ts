import { resolveViewedUser } from "@/server/auth/viewerScope";
import { loadShortlistBoard } from "@/server/views/shortlistBoard";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id } = await params;
  const board = await loadShortlistBoard(viewedUserId, id);
  if (!board) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(board);
}
