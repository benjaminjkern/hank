import { resolveViewedUser } from "@/server/auth/viewerScope";
import { getAttachment } from "@/server/platform/storage/attachments";
import { fileDownloadResponse } from "@/server/platform/storage/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download a chat-uploaded attachment by id. Scopes by resolveViewedUser; the
// getAttachment query is already keyed by userId so a mismatched id returns
// 404 rather than another user's file.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id } = await params;
  const att = await getAttachment(id, viewedUserId);
  if (!att) return Response.json({ error: "not found" }, { status: 404 });
  const bytes = new Uint8Array(att.fileBytes as unknown as ArrayBufferLike);
  return fileDownloadResponse(bytes, att.fileName, att.fileMime);
}
