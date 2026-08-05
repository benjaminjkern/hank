// The `attach_resume_to_profile` tool — thin wrapper over the
// runAttachResumeToProfile procedure (load attachment → parse → save). Maps the
// procedure's typed result to a ToolResult.

import { z } from "zod";

import { runAttachResumeToProfile } from "@/server/procedures/registry/attachResumeToProfile";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const attachResumeToProfileTool: ToolDef<{ attachmentId: string }> = {
  name: "attach_resume_to_profile",
  affectsViewedState: true,
  description:
    "Designate a previously-attached resume file as the user's resume. Accepts PDF attachments and .docx uploads (which are pre-extracted to text on upload). Reads the document and folds everything on it into what you know about the user's background, so a second or third resume adds to that background rather than replacing it. Use when the user has attached a resume and indicated it's their resume, or when context strongly suggests so. Shared — available in every flow (profile-building, walkthrough, watchlist, default), since a user may attach an updated resume mid-conversation regardless of what flow is running.",
  inputSchema: {
    type: "object",
    properties: {
      attachmentId: {
        type: "string",
        description:
          "Id of the attachment to attach to the profile as the resume (PDF or .docx).",
      },
    },
    required: ["attachmentId"],
  },
  parser: z.object({ attachmentId: z.string().min(1) }),
  async handle({ attachmentId }, ctx) {
    const r = await runAttachResumeToProfile({ ...ctx, attachmentId });
    if (!r.ok) {
      switch (r.kind) {
        case "not_found":
          return toolError(
            "ENTITY_NOT_FOUND",
            `attachment ${attachmentId} not found for this user. The id from the <attachments> manifest must match exactly — re-read the user's most recent message and try again.`,
            "attach_resume_to_profile:not_found:attachment",
          );
        case "invalid_media":
          return toolError(
            "INVALID_INPUT",
            `cannot attach ${r.fileName} to the profile — only PDF or .docx attachments can be resumes (this one is ${r.mediaKind}). Ask the user to attach a PDF or Word version.`,
            "attach_resume_to_profile:invalid:media_kind",
          );
        case "unparseable":
          return toolError(
            "SUB_AGENT_FAILED",
            `couldn't read ${r.fileName} as a resume: ${r.error}`,
            "attach_resume_to_profile:unparseable",
          );
      }
    }
    return {
      content: r.merged
        ? `read ${r.fileName} and merged it into what you know about the user's background.`
        : `read ${r.fileName} into the user's background.`,
    };
  },
};
