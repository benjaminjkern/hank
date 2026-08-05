// The résumé's two halves, and the seam between them.
//
// A `Resume` row is a FILE the user uploaded — bytes, name, MIME, nothing else.
// What the résumé SAYS lives in exactly one place, the `resume.md` memory note,
// which holds the user's whole background: every uploaded document merged in,
// plus whatever they told Hank in chat. So a user can have several résumés and
// still one background, and every reader — Hank's own context, the profile gate,
// every sub-agent — reads that one note.
//
// What does NOT belong in resume.md: how to frame the background, what to
// emphasize, stated preferences, rehearsed answers. Those are profile.md /
// frequent_questions.md. This note is raw background facts.

import { prisma } from "@/server/db/prisma";
import { readMemory, writeMemory } from "@/server/memory/store";

export const RESUME_PATH = "resume.md";

// What a prompt shows when the user has no background on file at all. One copy,
// because a dozen sub-agents render this same absence.
const NO_RESUME = "(no resume on file)";

// The user's background, ready to drop into a prompt. Every sub-agent that puts
// a résumé in front of a model reads THIS — there is no per-prompt summary
// variant to choose, which is the point: one version, in full detail, everywhere.
export async function readResumeBackground(userId: string): Promise<string> {
  const note = (await readMemory(userId, RESUME_PATH))?.trim();
  return note || NO_RESUME;
}

// Persist an uploaded résumé and the background it merged into. `markdown` is
// the COMPLETE merged note from parseResumeSubAgent (existing background folded
// together with this document), so it replaces resume.md wholesale.
export async function saveResume(
  userId: string,
  args: {
    fileName: string;
    fileMime: string;
    fileBytes: Uint8Array;
    markdown: string;
  },
) {
  const row = await prisma.resume.create({
    data: {
      userId,
      fileName: args.fileName,
      fileMime: args.fileMime,
      // Prisma 7's Bytes type wants Uint8Array<ArrayBuffer>; widen the cast since
      // the bytes from Request.arrayBuffer() come back as Uint8Array<ArrayBufferLike>.
      fileBytes: args.fileBytes as Uint8Array<ArrayBuffer>,
    },
  });
  await writeMemory(userId, RESUME_PATH, args.markdown);
  return row;
}
