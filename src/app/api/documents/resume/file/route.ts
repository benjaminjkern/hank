import { resolveViewedUser } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { fileDownloadResponse } from "@/server/platform/storage/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download one of the user's stored resume files, by `?id=`. Scopes by
// resolveViewedUser so the admin view-session UI downloads the inspected user's
// resume — and the userId is part of the lookup, so an id from another account
// 404s rather than serving someone else's file.
export async function GET(req: Request) {
  const { viewedUserId } = await resolveViewedUser(req);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });

  const resume = await prisma.resume.findFirst({
    where: { id, userId: viewedUserId },
    select: { fileBytes: true, fileName: true, fileMime: true },
  });
  if (!resume)
    return Response.json({ error: "no resume on file" }, { status: 404 });
  const bytes = new Uint8Array(resume.fileBytes as unknown as ArrayBufferLike);
  return fileDownloadResponse(bytes, resume.fileName, resume.fileMime);
}
