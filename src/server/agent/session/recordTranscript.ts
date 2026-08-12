// The ONE writer of streamed chat content: anything that reaches the user's
// screen gets a ChatMessage row here, written as it streams.
//
// One writer and not several, because the client reconciles from the DB on
// every terminal `done` — so the two ways of getting this wrong are symmetrical
// and both are fatal. Content yielded without a row erases itself a beat after
// it renders; content persisted twice repeats the whole run at the bottom of
// the chat the moment it finishes. Spread across per-emitter writes, one
// procedure reachable from two callers is enough to produce both.
//
// So content on the stream is this function's to persist, unless its emitter
// claimed the row with `message_start` … `message_end`. Exactly one emitter
// does: a Hank turn, whose row also carries `thinking` / `tool_use` blocks that
// never reach the stream at all and therefore cannot be written from here.
//
// The row is upserted per event rather than flushed at the end of a group,
// which is what makes a long batch visible WHILE it runs — /api/session is what
// a reconnecting or polling client reads, and a row that only lands when the
// batch finishes is a batch nobody can watch.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import type { TurnEvent } from "@/server/agent/contracts";
import { newRunTreeId } from "@/server/agent/runTree/ids";
import { prisma } from "@/server/db/prisma";

// The persisted shape of one streamed content event. Deliberately not
// Anthropic's ContentBlock: `pipeline_status` / `pipeline_widget` are our own
// block types, stored verbatim in ChatMessage.content and read by the client.
type ContentBlock = Record<string, unknown>;

export async function* recordTranscript(
  events: AsyncGenerator<TurnEvent>,
  args: { sessionId: string; runId?: string },
): AsyncGenerator<TurnEvent> {
  // The row this function is currently filling, and its blocks so far. Both
  // null between groups: a group opens on the first unclaimed content event and
  // closes when someone else claims a row.
  let rowId: string | null = null;
  let blocks: ContentBlock[] = [];
  // An emitter announced a row it writes itself; keep out until it releases.
  let claimed = false;

  for await (const ev of events) {
    if (ev.type === "message_start") {
      rowId = null;
      blocks = [];
      claimed = true;
      yield ev;
      continue;
    }
    if (ev.type === "message_end") {
      claimed = false;
      // Stream control for this function alone — the client has no use for it.
      continue;
    }
    const block = claimed ? null : contentBlockFor(ev);
    if (block === null) {
      yield ev;
      continue;
    }
    if (rowId === null) {
      rowId = newRunTreeId();
      // Name the row BEFORE the first event that lands in it, so the bubble the
      // client paints live is the row the reconcile loads back and the chat
      // doesn't re-cut itself when the run ends.
      yield { type: "message_start", messageId: rowId };
    }
    appendBlock(blocks, block);
    await writeRow(args, rowId, blocks);
    yield ev;
  }
}

// The block a content event persists as, or null if the event isn't content.
// tool_use_*, ui, refresh_viewed_state, stopped, error and done are stream
// control or turn outcome — they either belong to a row somebody else writes or
// to no row at all.
//
// Sub-agent trace emissions (`parentToolUseId` set) are content, but they
// render INSIDE a tool chip rather than as their own segment, and the chip's
// interior is persisted on the claimed row's `traces` column. Never ours.
function contentBlockFor(ev: TurnEvent): ContentBlock | null {
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
// naturally when a sentence is yielded in pieces. The client's mergeTextDelta
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
