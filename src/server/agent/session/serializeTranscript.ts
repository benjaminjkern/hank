// Flatten stored ChatMessage rows into the `[role]: text` plaintext that the
// compaction sub-agents read. One implementation, two callers with different
// appetites for machinery: compaction summarizes what a turn DID (tool calls
// included), memory consolidation only mines what was SAID.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { stripFocusRefTokens } from "@/lib/focusRefToken";
import { stripWidgetMarker } from "@/lib/widgetMarker";
import { isRecord } from "@/utils/guards";
import { truncate } from "@/utils/text";

export type StoredMessage = {
  role: Role;
  content: Prisma.JsonValue;
};

export function serializeTranscript(
  messages: StoredMessage[],
  opts?: { includeToolCalls?: boolean },
): string {
  const includeToolCalls = opts?.includeToolCalls ?? true;
  const lines: string[] = [];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
    if (m.role === Role.USER) {
      const text = extractText(blocks);
      if (text.trim()) lines.push(`[user]: ${text.trim()}`);
    } else if (m.role === Role.ASSISTANT) {
      const text = extractText(blocks);
      if (text.trim()) lines.push(`[assistant]: ${text.trim()}`);
      if (!includeToolCalls) continue;
      for (const b of blocks) {
        if (
          isRecord(b) &&
          b.type === "tool_use" &&
          typeof b.name === "string"
        ) {
          lines.push(`[tool_use ${b.name}]`);
        }
      }
    } else if (m.role === Role.TOOL && includeToolCalls) {
      for (const b of blocks) {
        if (!isRecord(b) || b.type !== "tool_result") continue;
        const result = typeof b.content === "string" ? b.content : "";
        if (result.trim()) {
          lines.push(`[tool_result]: ${truncate(result.trim(), 400)}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// What the user "said" this turn, including what they said by CLICKING.
//
// `panel_edits` is load-bearing here, not an extra: a board mark, an
// application rewrite and a discovery mark are all the user stating a
// preference without typing, and each one carries pre-rendered prose saying so.
// Dropping the block is what silently starved memory consolidation of its three
// richest signals while its prompt told it to quote them.
//
// `pipeline_activity` stays OUT on purpose — that channel is the machine's own
// bookkeeping ("condensed the earlier part of this conversation"), and feeding
// it to the pass that wrote it is circular.
//
// Text loses the two markups a reader must never quote back: a clicked message
// keeps its visible label and loses its hidden widget marker, and a chip line
// keeps its label and loses its <focus-ref/>. Both strips run on every block —
// a user never types a chip and the assistant never emits a marker, so there is
// nothing to gain from branching on role here.
function extractText(blocks: unknown[]): string {
  let out = "";
  for (const b of blocks) {
    if (isRecord(b) && b.type === "panel_edits" && typeof b.text === "string") {
      out += `${out ? "\n" : ""}${b.text}\n`;
    }
  }
  for (const b of blocks) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string")
      out += stripFocusRefTokens(stripWidgetMarker(b.text));
  }
  return out;
}
