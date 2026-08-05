// Turn an uploaded résumé into the user's background: read what the background
// already says → parse the document and merge the two → persist the file and the
// merged note.
//
// Two entries, because a résumé arrives two ways. `runAttachResumeToProfile` is
// the agent's (`attach_resume_to_profile`, resolving a prior chat attachment);
// `mergeResumeIntoBackground` is the shared chain underneath it, which the
// Documents page's direct upload route calls with bytes it already holds. The
// merge lives here once so the two paths can't drift into different answers for
// "what happens to the background on a second upload."

import type { RunContext } from "@/server/agent/contracts";
import { RESUME_PATH, saveResume } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";
import { getAttachment } from "@/server/platform/storage/attachments";
import { DOCX_MIME } from "@/server/platform/storage/docx";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  parseResumeSubAgent,
  type ParseResumeInput,
} from "@/server/subagents/registry/parseResume";

// Failures carry only what happened plus the data a message needs — the caller
// owns how it reads. `kind` (rather than a bare error string) because the three
// arms map to three different ToolErrorCodes, so the tool branches on it.
type AttachResumeToProfileResult =
  | { ok: true; fileName: string; merged: boolean }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid_media"; fileName: string; mediaKind: string }
  | { ok: false; kind: "unparseable"; fileName: string; error: string };

export type MergeResumeResult =
  // `merged` distinguishes a first upload from one folded into an existing
  // background — the only difference a caller's message needs to draw.
  { ok: true; merged: boolean } | { ok: false; error: string };

export async function mergeResumeIntoBackground(
  args: RunContext & {
    fileName: string;
    fileMime: string;
    // What gets stored as the file. For a .docx that's the extracted text, not
    // the original document — see the Resume model's header.
    storeBytes: Uint8Array;
    source: ParseResumeInput["source"];
  },
): Promise<MergeResumeResult> {
  // The raw note, not readResumeBackground's prompt-facing fallback: the parser
  // branches on "is there a background yet", and "(no resume on file)" is not one.
  const existingBackground = await readMemory(args.userId, RESUME_PATH);

  const parsed = await runSubAgent(
    parseResumeSubAgent,
    {
      fileName: args.fileName,
      existingBackground,
      source: args.source,
    },
    args,
  );
  // Nothing to save if it didn't parse — surface it rather than writing a Resume
  // row whose contents never reached the background.
  if (!parsed.ok) return { ok: false, error: parsed.error };

  await saveResume(args.userId, {
    fileName: args.fileName,
    fileMime: args.fileMime,
    fileBytes: args.storeBytes,
    markdown: parsed.output.markdown,
  });

  return { ok: true, merged: !!existingBackground?.trim() };
}

export async function runAttachResumeToProfile(
  args: RunContext & { attachmentId: string },
): Promise<AttachResumeToProfileResult> {
  const att = await getAttachment(args.attachmentId, args.userId);
  if (!att) {
    return { ok: false, kind: "not_found" };
  }
  const bytes = new Uint8Array(att.fileBytes as unknown as ArrayBufferLike);
  const isDocxText = att.mediaKind === "text" && att.fileMime === DOCX_MIME;

  if (att.mediaKind !== "pdf" && !isDocxText) {
    return {
      ok: false,
      kind: "invalid_media",
      fileName: att.fileName,
      mediaKind: att.mediaKind,
    };
  }

  const result = await mergeResumeIntoBackground({
    ...args,
    fileName: att.fileName,
    fileMime: att.fileMime,
    storeBytes: bytes,
    source:
      att.mediaKind === "pdf"
        ? { kind: "pdf", bytes }
        : { kind: "text", text: Buffer.from(bytes).toString("utf8") },
  });
  if (!result.ok) {
    return {
      ok: false,
      kind: "unparseable",
      fileName: att.fileName,
      error: result.error,
    };
  }

  return { ok: true, fileName: att.fileName, merged: result.merged };
}
