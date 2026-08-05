// Rebuild the Anthropic message array the model sees from persisted ChatMessage
// rows. This is where replay repair lives: orphaned tool_use/tool_result pairs,
// same-role coalescing, thinking-block normalization, and the provenance notes
// that tell Hank what the deterministic layer already put on screen.

import { renderWidgetText } from "@/components/Chat/widgets/registry";
import type { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/client";
import { stripFocusRefTokens } from "@/lib/focusRefToken";
import { buildProvenanceMessage } from "@/server/agent/session/uiProvenance";
import { prisma } from "@/server/db/prisma";
import { listAttachmentsForMessages } from "@/server/platform/storage/attachments";

import type Anthropic from "@anthropic-ai/sdk";

const STOPPED_REPLY_RESUME_NOTE =
  "[System note: your previous reply was cut off before it finished — the text " +
  "above is only the part that had streamed. If they're now asking you to " +
  "continue or pick up where you left off, resume from where that reply was cut " +
  "rather than starting over. Otherwise just handle their new message.]";

export async function loadSessionMessages(
  sessionId: string,
): Promise<{ messages: Anthropic.MessageParam[]; endsAwaitingUser: boolean }> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { summarizedUpToMessageId: true, summary: true },
  });

  let createdAtFilter: Prisma.DateTimeFilter | undefined;
  if (session?.summarizedUpToMessageId) {
    const cutoff = await prisma.chatMessage.findUnique({
      where: { id: session.summarizedUpToMessageId },
      select: { createdAt: true },
    });
    if (cutoff) createdAtFilter = { gt: cutoff.createdAt };
  }
  // Whether compaction actually dropped pre-cutoff messages from this replay.
  // Only THEN do we re-inject the summary below (a summary with no truncation
  // would duplicate context that's still fully present).
  const truncated = createdAtFilter !== undefined;

  const rawRows = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  // Defensive: the replay must start with a real Role.USER message so the
  // first user/assistant alternation is valid AND no tool_result block at the
  // head references a tool_use that lives only in the summary. runCompactSession
  // tries to land cutoffs on safe boundaries, but if a historical bad cutoff
  // is still in place (or one slips through), skip leading orphans here.
  let startIdx = 0;
  while (startIdx < rawRows.length && rawRows[startIdx].role !== Role.USER) {
    startIdx++;
  }
  const rows = rawRows.slice(startIdx);

  // Index of the most recent user message — its document/image blocks are
  // kept verbatim so Claude sees the file. Older user messages have their
  // file blocks swapped for short text placeholders so we don't re-pay the
  // token cost of re-uploading bytes on every loop iteration.
  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === Role.USER) {
      lastUserIdx = i;
      break;
    }
  }

  const historicalUserMessageIds = rows
    .filter((r, i) => r.role === Role.USER && i !== lastUserIdx)
    .map((r) => r.id);
  const attachmentRows = await listAttachmentsForMessages(
    historicalUserMessageIds,
  );
  const filenameByMessage = new Map<string, string[]>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const arr = filenameByMessage.get(a.messageId) ?? [];
    arr.push(a.fileName);
    filenameByMessage.set(a.messageId, arr);
  }

  const replayed: Anthropic.MessageParam[] = [];
  // Armed when the previous row was an assistant message the user cut off with
  // Stop. The partial (whatever streamed before the abort) is persisted as-is,
  // so the model would otherwise see an abruptly-truncated reply with no signal
  // it was interrupted. We inject a short model-facing note into the FOLLOWING
  // user turn (same side as the orphan-repair tool_results below) so Hank can
  // piece together that it was interrupted and offer to resume — there is no
  // first-class "continue" widget; this is the only resume affordance.
  let resumeNotePending = false;
  // True when the last content-bearing row was an ASSISTANT row with no tool_use
  // (a plain reply, or a re-roled status/widget provenance terminal). Tracked from
  // the ORIGINAL Prisma role, before provenance re-roling, so the terminal guard
  // below reads the raw rows rather than the re-roled history — see endsAwaitingUser.
  let tailIsAssistantNoTool = false;
  rows.forEach((r, i) => {
    const rawBlocks = r.content as unknown as Anthropic.ContentBlockParam[];

    // Pipeline-internal blocks (status narration + widget payloads emitted by the
    // deterministic state machine) are things the user SAW on screen — the agent
    // did NOT write them. Render each as a provenance note in a non-assistant
    // channel (a role:"system" message) so the model reads it as a record, not its
    // own prose. See uiProvenance.ts.
    // Pipeline rows are always pure (a status/widget block, role=ASSISTANT); a
    // pipeline block never shares a row with regular assistant text or tool_use.
    const isPipelineRow =
      rawBlocks.length > 0 &&
      rawBlocks.every((b) =>
        PIPELINE_BLOCK_TYPES.has((b as { type?: string }).type ?? ""),
      );
    if (isPipelineRow) {
      const note = pipelineRowNoteText(rawBlocks);
      if (note) {
        replayed.push(buildProvenanceMessage(note));
        // A provenance row is an ASSISTANT row with no tool_use, so it reads as
        // a terminal — nothing for the agent to respond to.
        tailIsAssistantNoTool = true;
      }
      // Recompute like every other row; a pipeline row is never a stopped human
      // reply, so this resets a pending note.
      resumeNotePending = r.role === Role.ASSISTANT && r.stoppedByUser === true;
      return;
    }

    // Non-pipeline rows pass through unchanged. A pipeline block never shares a
    // row with other content, but filter defensively (into a fresh array, so the
    // resume-note unshift below doesn't mutate the source) so a stray one can't
    // reach the API as an unknown block type.
    const blocks = rawBlocks
      .filter(
        (b) => !PIPELINE_BLOCK_TYPES.has((b as { type?: string }).type ?? ""),
      )
      .map((b) => {
        // Board-edit relays persist structured (chip data for the client) with
        // the model prose pre-rendered at write time — swap to a plain text
        // block so an unknown type never reaches the API.
        if ((b as { type?: string }).type === "panel_edits") {
          return {
            type: "text",
            text: (b as { text?: string }).text ?? "",
          } as Anthropic.ContentBlockParam;
        }
        return b;
      });
    if (blocks.length === 0) return;
    // A user turn following a stopped reply gets the interruption note prefixed.
    if (resumeNotePending && r.role === Role.USER) {
      blocks.unshift({ type: "text", text: STOPPED_REPLY_RESUME_NOTE });
    }
    resumeNotePending = r.role === Role.ASSISTANT && r.stoppedByUser === true;
    tailIsAssistantNoTool =
      r.role === Role.ASSISTANT && !blocks.some((b) => b.type === "tool_use");
    if (r.role === Role.USER && i !== lastUserIdx) {
      const filenames = filenameByMessage.get(r.id) ?? [];
      let nameIdx = 0;
      const stripped = blocks.map((b) => {
        if (b.type === "document" || b.type === "image") {
          const name = filenames[nameIdx++] ?? "file";
          return {
            type: "text",
            text: `[attached: ${name}]`,
          } as Anthropic.ContentBlockParam;
        }
        return b;
      });
      replayed.push({ role: anthropicRole(r.role), content: stripped });
      return;
    }
    replayed.push({ role: anthropicRole(r.role), content: blocks });
  });

  // Compaction re-injection: when pre-cutoff messages were dropped from this
  // replay, prepend the summary compaction wrote so Hank keeps continuity across
  // the condensed span. Without this the ENTIRE pre-cutoff transcript AND its
  // summary were invisible to the model — the single biggest "no trace" gap
  // (runCompactSession writes ChatSession.summary, but nothing read it back into
  // context). Rendered in the same non-assistant provenance channel as pipeline
  // notes so it reads as an operator record, not the model's own prose. Unshifted
  // BEFORE the transform passes so coalesceSameRole folds it into the first user
  // turn (Anthropic <system-reminder>) or leaves it as a leading system message
  // (DeepSeek).
  const summaryText = session?.summary?.trim();
  if (truncated && summaryText) {
    replayed.unshift(
      buildProvenanceMessage(
        `Earlier in this conversation (condensed to save space) — recap of everything before the messages that follow:\n\n${summaryText}`,
      ),
    );
  }

  // Coalesce before the orphan-repair passes: re-roled provenance / status rows can
  // leave adjacent same-role messages, which the API rejects. Merging runs of one
  // role into a single message is a safe, structure-preserving transform — it never
  // changes the turn SEQUENCE, so the tool_use ↔ tool_result adjacency the repair
  // passes rely on is untouched (provenance notes never land between a tool_use and
  // its result — pipeline rows are persisted at flow boundaries / after tool
  // results, never mid-tool-loop).
  const messages = normalizeThinkingForReplay(
    repairOrphanToolUses(stripOrphanToolResults(coalesceSameRole(replayed))),
  );

  // Should the caller stop instead of invoking the agent? Yes when the last thing in
  // history is a completed assistant/UI turn with nothing new to respond to:
  //   - the last content-bearing row was an ASSISTANT row with no tool_use (a plain
  //     reply, or a re-roled status/widget provenance terminal), OR
  //   - the post-repair history still ends on an assistant message (an invalid
  //     prefill — belt-and-suspenders for the orphan-strip self-heal edge).
  // A trailing tool_use (crashed mid-loop) is NOT terminal — repairOrphanToolUses
  // appends a synthetic result and the agent runs to recover. Computed from raw
  // rows so it's provider-proof (it never inspects the re-roled provenance role),
  // and it matches the prior historyEndsWithAssistant semantics.
  const endsAwaitingUser =
    tailIsAssistantNoTool ||
    messages[messages.length - 1]?.role === "assistant";

  return { messages, endsAwaitingUser };
}

// The main agent now runs with extended thinking on (agentRunner.ts), so
// assistant turns carry `thinking` blocks. When thinking is enabled the API
// requires that the assistant turn whose tool call is being continued — the one
// immediately before the trailing `tool_result` message — START with its
// thinking block(s), signatures intact. Every OTHER assistant turn's thinking is
// not needed on the next request (and a stale cross-turn signature is a needless
// risk), so we strip it. Net effect:
//   - History ending on a tool_result (mid tool-loop): keep thinking-first on the
//     single preceding assistant turn (coalesceSameRole can prepend a converted
//     pipeline-status text block ahead of it, so we re-front it), strip the rest.
//   - History ending on a plain user message (a fresh turn): strip ALL thinking.
// Pre-thinking history has no thinking blocks, so this is a no-op there.
function normalizeThinkingForReplay(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const isThinking = (b: Anthropic.ContentBlockParam) =>
    b.type === "thinking" || b.type === "redacted_thinking";
  const last = messages[messages.length - 1];
  const lastIsToolResult =
    !!last &&
    last.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((b) => b.type === "tool_result");
  // The active continuation is the assistant turn right before that tool_result.
  const keepIdx = lastIsToolResult ? messages.length - 2 : -1;
  const mapped = messages.flatMap((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return [m];
    const blocks = m.content;
    const thinking = blocks.filter(isThinking);
    if (thinking.length === 0) return [m];
    const rest = blocks.filter((b) => !isThinking(b));
    if (i === keepIdx && rest.some((b) => b.type === "tool_use")) {
      return [{ role: m.role, content: [...thinking, ...rest] }];
    }
    // A thinking-ONLY assistant turn (no text, no tool_use — the DeepSeek
    // failure mode where the model "responds" with reasoning only) strips down
    // to an empty content array here. Anthropic rejects empty content on the
    // next request, which permanently BRICKS the session: every subsequent user
    // message re-sends the same invalid history and 400s before the agent runs.
    // Drop the now-empty turn entirely (the user saw nothing for it anyway);
    // coalesceSameRole below re-merges any neighbors this leaves adjacent.
    if (rest.length === 0) return [];
    return [{ role: m.role, content: rest }];
  });
  // Re-coalesce: dropping an empty assistant turn between two user messages
  // (the upstream call site coalesces BEFORE this pass) would otherwise strand
  // consecutive same-role messages, which the API also rejects.
  return coalesceSameRole(mapped);
}

// UI-only content blocks the deterministic pipeline persists into
// ChatMessage.content (status narration, widget payloads, a failed run's error).
// Anthropic rejects the raw block types, and the user SAW these on screen (the one
// exception is pipeline_activity), so on replay we render them to
// a plain-text note the model reads for grounding — Hank needs to remember what it
// showed (a shortlist it rendered, a picker it surfaced) when the user types free
// text about it instead of clicking. pipelineRowNoteText builds that note text;
// buildProvenanceMessage (uiProvenance.ts) wraps it in a non-assistant channel (a
// role:"system" message). Widget text goes through the shared renderWidgetText so
// the model's grounding matches what the QA persona-simulator perceives. Keep the
// *segment* converter in src/app/api/session/route.ts (the UI render path) in sync
// structurally.
//
// PROVENANCE: pipeline rows are ASSISTANT rows, so a note left in the assistant
// channel reads to the model as its own prior prose and gets imitated — it
// confabulates a fake on-screen role list. Emitting it as a role:"system"
// message is what keeps it off that channel; an assistant-authored stage
// direction ("[Shown to the user …]") is not a substitute, whatever it's tagged.
// The block types Anthropic would reject — every one of them goes through
// pipelineRowNoteText instead. One list, because the two places that need it
// (detect a pure-pipeline row; strip strays from a mixed row) drifting apart
// would send an unknown block type straight to the API.
const PIPELINE_BLOCK_TYPES = new Set([
  "pipeline_status",
  "pipeline_widget",
  "pipeline_activity",
  "run_error",
]);

type PipelineUiBlock = {
  type?: string;
  text?: string;
  detail?: string;
  kind?: string;
  payload?: unknown;
};
// Human-readable "shown to the user" record for a pipeline row's block(s). Returns
// null when nothing renders (unknown widget kind / malformed payload / empty status)
// so the row is dropped rather than emitting an empty note.
function pipelineRowNoteText(blocks: PipelineUiBlock[]): string | null {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "pipeline_status") {
      // Strip <focus-ref/> markup to its bare label — the model must see
      // "Pulled up Stripe", never the raw token (never learn to imitate it).
      const text = stripFocusRefTokens(
        typeof b.text === "string" ? b.text.trim() : "",
      );
      if (text) parts.push(`Shown to the user: ${text}`);
    } else if (b.type === "pipeline_widget") {
      const rendered = renderWidgetText(b.kind ?? "", b.payload);
      if (rendered)
        parts.push(`Shown to the user (interactive widget):\n${rendered}`);
    } else if (b.type === "pipeline_activity") {
      // Deterministic bookkeeping the pipeline did between turns that was NOT
      // shown to the user (memory consolidation, history compaction, etc.).
      // Relayed so Hank is aware of it rather than finding state silently
      // changed — but framed as internal, so he never narrates it to the user.
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (text)
        parts.push(
          `Between turns (automatic bookkeeping — the user did NOT see this, so don't mention it to them): ${text}`,
        );
    } else if (b.type === "run_error") {
      // The run failed outright and the user is looking at an error row. Hank
      // sees the raw detail so he can say what didn't happen and offer to retry
      // — but it's operator text, so the framing tells him not to quote it.
      const detail = typeof b.detail === "string" ? b.detail.trim() : "";
      if (detail)
        parts.push(
          `That attempt FAILED partway through and the user is looking at an error notice. Nothing after this point ran, and any work it was in the middle of did not save. Offer to try again; describe the failure in your own plain words and never quote this text: ${detail}`,
        );
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// Merge consecutive messages that share a role into one message (concatenating
// their content arrays). Anthropic requires strict user/assistant alternation;
// converting pipeline UI blocks to text can produce back-to-back assistant
// messages (e.g. an assistant reply followed by a standalone widget row).
// Copies content arrays so the source messages aren't mutated.
function coalesceSameRole(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === m.role &&
      Array.isArray(prev.content) &&
      Array.isArray(m.content)
    ) {
      prev.content = [...prev.content, ...m.content];
    } else {
      out.push({
        role: m.role,
        content: Array.isArray(m.content) ? [...m.content] : m.content,
      });
    }
  }
  return out;
}

// Anthropic requires every `tool_result` block to reference a `tool_use` in the
// immediately-preceding assistant message. The orphan-tool-USE repair below
// slugs the common case (assistant called a tool, the pipeline runner crashed
// before persisting the result). The inverse — a stored tool_result with NO
// preceding tool_use — only arises from interleaved concurrent runs on one
// session, which runUserMessage's ALREADY_STREAMING guard now refuses; the
// repair stays for sessions whose history already holds such a row, since they
// would otherwise fail to replay forever. Sanitizes the model's view only — the
// full row is preserved in the DB for audit.
function stripOrphanToolResults(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const blocks = m.content;
    if (!blocks.some((b) => b.type === "tool_result")) {
      out.push(m);
      continue;
    }
    const prev = out[out.length - 1];
    const validIds = new Set<string>();
    if (prev?.role === "assistant" && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b.type === "tool_use") validIds.add(b.id);
      }
    }
    const kept = blocks.filter(
      (b) => b.type !== "tool_result" || validIds.has(b.tool_use_id),
    );
    if (kept.length === blocks.length) {
      out.push(m);
      continue;
    }
    if (kept.length === 0) {
      // Whole row was orphan tool_results — drop it; the preceding assistant
      // message stands alone and the next message follows it directly.
      continue;
    }
    out.push({ ...m, content: kept });
  }
  return out;
}

// Anthropic requires every `tool_use` block in an assistant message to be
// paired with a `tool_result` block in the immediately-following user message.
// If the agent loop crashes (or a tool gets renamed/removed) between persisting
// the assistant message and persisting the tool result, replay will 400 the
// API. We defensively inject synthetic tool_result blocks for any orphans so
// the conversation can continue. Marked is_error=true so the model knows the
// call failed and doesn't double-act on it.
function repairOrphanToolUses(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const repaired: Anthropic.MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    repaired.push(m);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

    const toolUseIds: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_use") toolUseIds.push(b.id);
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const covered = new Set<string>();
    if (next?.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b.type === "tool_result") covered.add(b.tool_use_id);
      }
    }
    const missing = toolUseIds.filter((id) => !covered.has(id));
    if (missing.length === 0) continue;

    const synthetic: Anthropic.ToolResultBlockParam[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content:
        "(tool call was abandoned — no result was persisted; treat as failed)",
      is_error: true,
    }));

    if (next?.role === "user" && Array.isArray(next.content)) {
      // Merge synthetic results into the next user message. Skip the original
      // next-message iteration so it isn't double-pushed.
      repaired.push({
        ...next,
        content: [...synthetic, ...next.content],
      });
      i++;
    } else {
      // No following user message (or it's a tool/assistant row) — inject a
      // synthetic user message carrying just the missing results.
      repaired.push({ role: "user", content: synthetic });
    }
  }
  return repaired;
}

function anthropicRole(role: Role): "user" | "assistant" {
  // Tool results are conveyed as user-role messages with tool_result blocks per
  // the Anthropic API. We store them with role=TOOL for our own clarity but
  // map back to "user" when replaying for the model.
  if (role === Role.ASSISTANT) return "assistant";
  return "user";
}
