// Persist a turn's messages. Every write that appends to a ChatSession's
// transcript — user turns, assistant replies, deterministic-layer activity notes,
// and tool results — goes through one of these.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  linkAttachmentsToMessage,
  listAttachmentsByIds,
} from "@/server/platform/storage/attachments";
import { toAnthropicBlock } from "@/server/platform/storage/contentBlocks";

import type Anthropic from "@anthropic-ai/sdk";

export async function appendUserMessage(
  sessionId: string,
  text: string,
  attachmentIds: string[] = [],
  opts: {
    // Run-tree capture (admin /admin/runs): stamp the run this message belongs
    // to so the viewer groups the whole run. Omitted on paths with no run.
    runId?: string;
    // Blocks to persist AHEAD of the typed text and the attachments — what the
    // user did on screen between their last message and this one. The caller
    // builds them because what a panel edit IS is domain knowledge; this
    // function only knows the transcript shape.
    leadingBlocks?: Anthropic.ContentBlockParam[];
  } = {},
) {
  const { userId } = await prisma.chatSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { userId: true },
  });

  const blocks: Anthropic.ContentBlockParam[] = [...(opts.leadingBlocks ?? [])];
  // One read for every attachment, then walk them in the order the client sent
  // — a lookup per id would be a round trip per file, and these can be large.
  const attachments = await listAttachmentsByIds(attachmentIds, userId);
  const attachmentById = new Map(attachments.map((a) => [a.id, a]));
  const manifestLines: string[] = [];
  for (const id of attachmentIds) {
    const att = attachmentById.get(id);
    if (!att) continue;
    manifestLines.push(
      `  <attachment id="${att.id}" name="${att.fileName}" kind="${att.mediaKind}" />`,
    );
    blocks.push(
      toAnthropicBlock({
        fileName: att.fileName,
        fileMime: att.fileMime,
        fileBytes: att.fileBytes,
        mediaKind: att.mediaKind,
      }),
    );
  }
  if (manifestLines.length > 0) {
    blocks.unshift({
      type: "text",
      text: `<attachments>\n${manifestLines.join("\n")}\n</attachments>`,
    });
  }
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }
  if (blocks.length === 0) {
    // No text, no resolvable attachments. Caller upstream guards this; this
    // is the defensive fallback so we never persist a zero-block message.
    blocks.push({ type: "text", text: "" });
  }

  const message = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.USER,
      content: blocks as unknown as Prisma.InputJsonValue,
      runId: opts.runId ?? null,
    },
  });

  if (attachmentIds.length > 0) {
    await linkAttachmentsToMessage(
      message.id,
      attachmentIds,
      sessionId,
      userId,
    );
  }

  return message;
}

export async function appendAssistantMessage(
  sessionId: string,
  blocks: Anthropic.ContentBlock[],
  // `id` lets the caller pre-generate the row id so it can be used as the
  // sub-agent parentMessageId BEFORE the row is written (the main loop pre-mints
  // it, sets it on the ALS capture context, runs tools, then persists here).
  // runId/turnIndex group + order the run; traces holds the sub-agent interior
  // map (admin /admin/runs). All optional — legacy callers pass none.
  opts: {
    stoppedByUser?: boolean;
    id?: string;
    runId?: string;
    turnIndex?: number;
    // The accumulated sub-agent interior trace map (traceAccumulator's snapshot).
    // `unknown` because TraceMap's value types don't structurally satisfy Prisma's
    // InputJsonValue; cast at the write below.
    traces?: unknown;
  } = {},
) {
  return await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.ASSISTANT,
      content: blocks as unknown as Prisma.InputJsonValue,
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.stoppedByUser ? { stoppedByUser: true } : {}),
      runId: opts.runId ?? null,
      turnIndex: opts.turnIndex ?? null,
      ...(opts.traces != null ? { traces: opts.traces } : {}),
    },
  });
}

// Persist a Hank-ONLY activity note: deterministic bookkeeping the pipeline did
// between turns (memory consolidation, history compaction, a silent status
// flip) that the user did NOT see. Stored as a lone `pipeline_activity` block on
// an ASSISTANT row so:
//   - the client drops it (buildAssistantSegments emits no segment for it, and
//     zero-segment assistant bubbles are filtered out in api/session/route.ts),
//     so it never renders in chat, AND
//   - loadSessionMessages replays it as a `<system-reminder>` / role:"system"
//     provenance note (see pipelineRowNoteText), so Hank IS aware of it.
// This is the "relay side effects to Hank, don't surface them to the user"
// channel — the answer to "nothing should change behind Hank's back."
export async function appendPipelineActivity(
  sessionId: string,
  text: string,
  opts: { runId?: string } = {},
) {
  return await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.ASSISTANT,
      content: [{ type: "pipeline_activity", text }],
      runId: opts.runId ?? null,
    },
  });
}

// Persist a run that FAILED, as a lone `run_error` block on an ASSISTANT row.
//
// The row is the whole point. A thrown run reaches the client as an SSE `error`
// followed by a terminal `done`, and that `done` makes the client reconcile from
// the DB — so an error painted only into client memory is replaced away a beat
// after it appears. Written by runUserMessage before it re-throws; rendered as
// an expandable "something went wrong" row (collapsed label is UI chrome, so
// only the raw detail is stored) and replayed to Hank as a provenance note.
export async function appendRunError(
  sessionId: string,
  detail: string,
  opts: { runId?: string } = {},
) {
  return await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.ASSISTANT,
      content: [{ type: "run_error", detail }],
      runId: opts.runId ?? null,
    },
  });
}

export async function appendToolResultMessage(
  sessionId: string,
  results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  capture: { runId?: string; turnIndex?: number } = {},
) {
  return await prisma.chatMessage.create({
    data: {
      sessionId,
      role: Role.TOOL,
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
      runId: capture.runId ?? null,
      turnIndex: capture.turnIndex ?? null,
    },
  });
}
