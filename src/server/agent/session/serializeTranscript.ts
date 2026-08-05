// Flatten stored ChatMessage rows into the `[role]: text` plaintext that the
// compaction sub-agents read. One implementation, two callers with different
// appetites for machinery: compaction summarizes what a turn DID (tool calls
// included), memory consolidation only mines what was SAID.

import { Role } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
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

function extractText(blocks: unknown[]): string {
  let out = "";
  for (const b of blocks) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string")
      out += b.text;
  }
  return out;
}
