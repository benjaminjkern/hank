import { getCurrentUser } from "@/server/auth/currentUser";
import {
  rejectImpersonatedWrite,
  resolveViewedUser,
} from "@/server/auth/viewerScope";
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

// Drop one stored resume file. What the resume SAID was merged into the
// `resume.md` note at upload time and stays there — this removes the file, not
// the background, and there is no un-merge. It is also the only copy of the
// original (bytes live in Postgres), so the UI confirms first.
//
// deleteMany rather than delete: an id that isn't this user's should be a
// no-op, not a P2025 throw that leaks whether the row exists.
export async function DELETE(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });

  const { count } = await prisma.resume.deleteMany({
    where: { id, userId: user.id },
  });
  if (count === 0) {
    return Response.json({ error: "no resume on file" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
