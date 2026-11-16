// The chat panel's transcript loader — one page of a session's persisted
// ChatMessage rows, converted from model-shaped content blocks into the segments
// the chat renders. Feeds GET /api/session (first load, reconcile, and "load
// older"). The payload types are shared/views/chatTranscript.ts.

import { prisma } from "@/server/db/prisma";
import { Role } from "@/server/generated/prisma/client";
import type { Prisma } from "@/server/generated/prisma/client";
import { HIDDEN_TOOLS } from "@/server/platform/agent/streamingCore";
import { listAttachmentsForMessages } from "@/server/platform/storage/attachments";
import { isRecord } from "@/shared/utils/guards";
import type {
  AttachmentView,
  ChatTranscriptPage,
  MessageView,
  PanelEditView,
  Segment,
  ToolSegment,
} from "@/shared/views/chatTranscript";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Tool names whose tool_use/tool_result blocks are filtered out before
// reaching the UI. They remain in the DB and in the model's replay history.
// `before` (an ISO timestamp) and `limit` are the raw query-string values; an
// unparseable `before` reads as no cursor, and `limit` clamps to 1…MAX_LIMIT.
export async function loadChatTranscriptPage(
  sessionId: string,
  query: { before: string | null; limit: string | null },
): Promise<ChatTranscriptPage> {
  const limitParam = Number(query.limit ?? DEFAULT_LIMIT);
  const limit = Math.min(
    Math.max(1, Number.isFinite(limitParam) ? limitParam : DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const beforeDate = query.before ? new Date(query.before) : null;
  const isPaging = beforeDate !== null && !Number.isNaN(beforeDate.getTime());

  // Take `limit + 1` newest matching rows so we can detect whether more exist.
  const messageWhere: Prisma.ChatMessageWhereInput = {
    sessionId,
    ...(isPaging ? { createdAt: { lt: beforeDate } } : {}),
  };
  const rawDesc = await prisma.chatMessage.findMany({
    where: messageWhere,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });
  const hasMore = rawDesc.length > limit;
  const rawMessages = rawDesc.slice(0, limit).reverse();
  const userMessageIds = rawMessages
    .filter((m) => m.role === Role.USER)
    .map((m) => m.id);
  const attachmentRows = await listAttachmentsForMessages(userMessageIds);
  const attachmentsByMessage = new Map<string, AttachmentView[]>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const arr = attachmentsByMessage.get(a.messageId) ?? [];
    arr.push({
      attachmentId: a.id,
      fileName: a.fileName,
      mediaKind: a.mediaKind,
    });
    attachmentsByMessage.set(a.messageId, arr);
  }

  return {
    messages: convertMessages(rawMessages, attachmentsByMessage),
    hasMore,
    isPaging,
  };
}

type ChatMessageRow = {
  id: string;
  role: Role;
  content: Prisma.JsonValue;
  traces: Prisma.JsonValue;
  stoppedByUser: boolean;
  createdAt: Date;
};

function convertMessages(
  rows: ChatMessageRow[],
  attachmentsByMessage: Map<string, AttachmentView[]>,
): MessageView[] {
  const out: MessageView[] = [];
  // Track tool_use_ids we filtered out so we can also drop their tool_results.
  const hiddenToolUseIds = new Set<string>();

  for (const row of rows) {
    const blocks = Array.isArray(row.content) ? (row.content as unknown[]) : [];

    if (row.role === Role.USER) {
      const text = collectUserText(blocks);
      const attachments = attachmentsByMessage.get(row.id);
      const panelEdits = collectPanelEdits(blocks);
      out.push({
        id: row.id,
        role: "user",
        createdAt: row.createdAt.toISOString(),
        segments: text ? [{ kind: "text", text }] : [],
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(panelEdits.length > 0 ? { panelEdits } : {}),
      });
    } else if (row.role === Role.ASSISTANT) {
      out.push({
        id: row.id,
        role: "assistant",
        createdAt: row.createdAt.toISOString(),
        segments: buildAssistantSegments(blocks, hiddenToolUseIds, row.traces),
        ...(row.stoppedByUser ? { stoppedByUser: true } : {}),
      });
    } else if (row.role === Role.TOOL) {
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        for (const block of blocks) {
          if (!isRecord(block) || block.type !== "tool_result") continue;
          const toolUseId =
            typeof block.tool_use_id === "string"
              ? block.tool_use_id
              : undefined;
          if (!toolUseId || hiddenToolUseIds.has(toolUseId)) continue;
          const result = typeof block.content === "string" ? block.content : "";
          const isError = block.is_error === true;
          const seg = last.segments.find(
            (s): s is ToolSegment => s.kind === "tool" && s.id === toolUseId,
          );
          if (seg) {
            seg.status = isError ? "error" : "done";
            seg.result = result;
          }
        }
      }
    }
  }

  // Drop assistant bubbles that ended up with zero segments after filtering
  // (hidden tools, etc). Widget-only messages are KEPT so the latestProposal
  // scanner can find them — ChatPanel skips rendering their bubble at the
  // view layer instead.
  return out.filter((m) => m.segments.length > 0 || m.role === "user");
}

// The `panel_edits` snapshot block on a user row → chip data. The block's
// `text` is the model-facing prose; the client renders from `edits`.
function collectPanelEdits(blocks: unknown[]): PanelEditView[] {
  const out: PanelEditView[] = [];
  for (const b of blocks) {
    if (!isRecord(b) || b.type !== "panel_edits" || !Array.isArray(b.edits)) {
      continue;
    }
    for (const e of b.edits) {
      if (!isRecord(e) || typeof e.title !== "string") continue;
      out.push({
        title: e.title,
        companyName: typeof e.companyName === "string" ? e.companyName : null,
        verdict: typeof e.verdict === "string" ? e.verdict : "",
      });
    }
  }
  return out;
}

// User messages may include an `<attachments>` manifest and inlined `<file …>`
// blocks the agent sees — strip those before showing the user's actual text.
function collectUserText(blocks: unknown[]): string {
  let out = "";
  for (const b of blocks) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.startsWith("<attachments>")) continue;
      if (b.text.startsWith("<file ")) continue;
      out += b.text;
    }
  }
  return out;
}

function buildAssistantSegments(
  blocks: unknown[],
  hiddenToolUseIds: Set<string>,
  traces: Prisma.JsonValue,
): Segment[] {
  const segments: Segment[] = [];
  const traceMap = isRecord(traces) ? traces : null;
  for (const b of blocks) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string") {
      const last = segments[segments.length - 1];
      if (last && last.kind === "text") {
        last.text += b.text;
      } else {
        segments.push({ kind: "text", text: b.text });
      }
    } else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "";
      const id = typeof b.id === "string" ? b.id : "";
      if (HIDDEN_TOOLS.has(name)) {
        if (id) hiddenToolUseIds.add(id);
        continue;
      }
      const trace = id && traceMap ? traceMap[id] : null;
      const children = trace ? convertTrace(trace) : undefined;
      segments.push({
        kind: "tool",
        id,
        name,
        input: b.input,
        status: "pending",
        ...(children && children.length > 0 ? { children } : {}),
      });
    } else if (b.type === "pipeline_status" && typeof b.text === "string") {
      segments.push({ kind: "status", text: b.text });
    } else if (
      b.type === "pipeline_widget" &&
      typeof b.toolUseId === "string" &&
      typeof b.kind === "string"
    ) {
      segments.push({
        kind: "widget",
        toolUseId: b.toolUseId,
        widgetKind: b.kind,
        payload: b.payload,
      });
    } else if (b.type === "run_error" && typeof b.detail === "string") {
      segments.push({ kind: "error", detail: b.detail });
    }
  }
  return segments;
}

// Convert a persisted ToolTrace (or recursive child node) into the same
// Segment[] shape the live stream produces. Defensive against malformed
// rows (third-party tools that wrote to the column, partial state, etc.).
function convertTrace(raw: unknown): Segment[] {
  if (!isRecord(raw)) return [];
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const out: Segment[] = [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    if (step.kind === "text" && typeof step.text === "string") {
      out.push({ kind: "text", text: step.text });
    } else if (step.kind === "tool" && typeof step.id === "string") {
      const result = typeof step.result === "string" ? step.result : undefined;
      const status: ToolSegment["status"] =
        result === undefined
          ? "pending"
          : step.error === true
            ? "error"
            : "done";
      const childChildren = step.children
        ? convertTrace(step.children)
        : undefined;
      out.push({
        kind: "tool",
        id: step.id,
        name: typeof step.name === "string" ? step.name : "",
        input: step.input,
        status,
        ...(result !== undefined ? { result } : {}),
        ...(childChildren && childChildren.length > 0
          ? { children: childChildren }
          : {}),
      });
    } else if (step.kind === "span") {
      // A procedure bracket — structure for the run-tree inspector, not for the
      // user. FLATTEN it: its children render inline, so a procedure never
      // appears in chat as though Hank had called a tool ("The screen is not
      // yours to draw").
      out.push(...(step.children ? convertTrace(step.children) : []));
    }
  }
  return out;
}
