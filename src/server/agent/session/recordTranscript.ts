// The ONE writer of streamed chat content: anything that reaches the user's
// screen gets a ChatMessage row here, written as it streams.
//
// One writer and not several, because the client reconciles from the DB on
// every terminal `done` — so the two ways of getting this wrong are symmetrical
// and both are fatal. Content said without a row erases itself a beat after
// it renders; content persisted twice repeats the whole run at the bottom of
// the chat the moment it finishes. Spread across per-emitter writes, one
// procedure reachable from two callers is enough to produce both.
//
// So content said to the user is this function's to persist, unless its emitter
// claimed the row with `message_start` … `message_end`. Exactly one emitter
// does: a Hank turn, whose row also carries `thinking` / `tool_use` blocks that
// never reach the stream at all and therefore cannot be written from here.
//
// The row is upserted per event rather than flushed at the end of a group,
// which is what makes a long batch visible WHILE it runs — /api/session is what
// a reconnecting or polling client reads, and a row that only lands when the
// batch finishes is a batch nobody can watch.

import { newRunTreeId } from "@/server/platform/agent/ids";
import type { StreamEvent } from "@/shared/chatStream";
import type { Say } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { Role } from "@/server/generated/prisma/client";
import type { Prisma } from "@/server/generated/prisma/client";

// The persisted shape of one streamed content event. Deliberately not
// Anthropic's ContentBlock: `pipeline_status` / `pipeline_widget` are our own
// block types, stored verbatim in ChatMessage.content and read by the client.
type ContentBlock = Record<string, unknown>;

// Wrap `downstream` (what reaches the client) in the transcript writer: the
// returned `say` persists each content event, then passes it on. Calls run one
// at a time in the order they were made — two callers saying concurrently (the
// enrichment pool's workers) would otherwise race their upserts on one row and
// a later write could land the older block list.
export function recordTranscript(
  args: { sessionId: string; runId?: string },
  downstream: Say,
): Say {
  // The row this function is currently filling, and its blocks so far. Both
  // null between groups: a group opens on the first unclaimed content event and
  // closes when someone else claims a row.
  let rowId: string | null = null;
  let blocks: ContentBlock[] = [];
  // An emitter announced a row it writes itself; keep out until it releases.
  let claimed = false;

  const record = async (ev: StreamEvent): Promise<void> => {
    if (ev.type === "message_start") {
      rowId = null;
      blocks = [];
      claimed = true;
      await downstream(ev);
      return;
    }
    if (ev.type === "message_end") {
      // Stream control for this function alone — the client has no use for it.
      claimed = false;
      return;
    }
    const block = claimed ? null : contentBlockFor(ev);
    if (block === null) {
      await downstream(ev);
      return;
    }
    if (rowId === null) {
      rowId = newRunTreeId();
      // Name the row BEFORE the first event that lands in it, so the bubble the
      // client paints live is the row the reconcile loads back and the chat
      // doesn't re-cut itself when the run ends.
      await downstream({ type: "message_start", messageId: rowId });
    }
    appendBlock(blocks, block);
    await writeRow(args, rowId, blocks);
    await downstream(ev);
  };

  let tail: Promise<void> = Promise.resolve();
  return (ev) => {
    const next = tail.then(() => record(ev));
    // A failed write rejects for the caller that said it; the next event still
    // gets its turn.
    tail = next.catch(() => {});
    return next;
  };
}

// The block a content event persists as, or null if the event isn't content.
// tool_use_*, ui, refresh_viewed_state, stopped, error and done are stream
// control or turn outcome — they either belong to a row somebody else writes or
// to no row at all.
//
// Sub-agent trace emissions (`parentToolUseId` set) are content, but they
// render INSIDE a tool chip rather than as their own segment, and the chip's
// interior is persisted on the claimed row's `traces` column. Never ours.
function contentBlockFor(ev: StreamEvent): ContentBlock | null {
  if (ev.type === "text") {
    return ev.parentToolUseId ? null : { type: "text", text: ev.text };
  }
  if (ev.type === "pipeline_status") {
    return { type: "pipeline_status", text: ev.text };
  }
  if (ev.type === "pipeline_widget") {
    return {
      type: "pipeline_widget",
      toolUseId: ev.toolUseId,
      kind: ev.kind,
      payload: ev.payload,
    };
  }
  return null;
}

// Coalesce consecutive text into one block — Anthropic-friendly, and it reads
// naturally when a sentence is said in pieces. The client's mergeTextDelta
// applies the same rule to the same events, so the live bubble and the
// persisted row agree block for block.
function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1];
  if (
    block.type === "text" &&
    last?.type === "text" &&
    typeof last.text === "string"
  ) {
    last.text += block.text as string;
    return;
  }
  blocks.push(block);
}

// Create the row on its first block, then keep it current as more land. Upsert
// rather than create-then-update so the two cases are one statement and one
// round trip — these fire per streamed event.
async function writeRow(
  args: { sessionId: string; runId?: string },
  id: string,
  blocks: ContentBlock[],
): Promise<void> {
  const content = blocks as unknown as Prisma.InputJsonValue;
  await prisma.chatMessage.upsert({
    where: { id },
    create: {
      id,
      sessionId: args.sessionId,
      role: Role.ASSISTANT,
      content,
      runId: args.runId ?? null,
    },
    update: { content },
  });
}
