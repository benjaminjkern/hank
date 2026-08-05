import { notFound } from "next/navigation";

import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";
import { costOf } from "@/server/platform/usage/pricing";
import { asArray, asString, isRecord } from "@/utils/guards";

import { RunTreeView } from "./RunTreeView";

import type {
  LlmCallInfo,
  RunItem,
  RunTree,
  SubAgentNode,
  ToolCallNode,
} from "../types";

export const dynamic = "force-dynamic";

// Collect the user-visible text from a USER row's content blocks (drop the
// <attachments> manifest + inlined file blocks, mirroring the chat replay).
function userText(blocks: unknown[]): string {
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

export default async function AdminRunTreePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  await requireAdmin();
  const { runId: rawParam } = await params;
  const runId = decodeURIComponent(rawParam);
  const legacy = runId.startsWith("legacy:");
  const legacySessionId = legacy ? runId.slice("legacy:".length) : null;

  // 1. The run's ChatMessage rows, in order.
  const messages = await prisma.chatMessage.findMany({
    where: legacy ? { runId: null, sessionId: legacySessionId! } : { runId },
    select: {
      id: true,
      role: true,
      content: true,
      traces: true,
      stoppedByUser: true,
      turnIndex: true,
      createdAt: true,
      sessionId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (messages.length === 0) notFound();

  const sessionId = messages[0].sessionId;
  const firstAt = messages[0].createdAt;
  const lastAt = messages[messages.length - 1].createdAt;

  // 2. TokenUsage for this run, keyed by the assistant messageId it produced.
  const usageRows = legacy
    ? []
    : await prisma.tokenUsage.findMany({
        where: { runId },
        select: {
          messageId: true,
          parentToolUseId: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheCreationInputTokens: true,
          cacheReadInputTokens: true,
          webSearchRequests: true,
          notes: true,
          requestParams: true,
          systemPromptHash: true,
        },
      });
  // Main-agent turn usage = rows with no parentToolUseId, keyed by messageId.
  const usageByMessage = new Map<string, (typeof usageRows)[number]>();
  let runCost = 0;
  for (const u of usageRows) {
    runCost += costOf(u);
    if (u.messageId && !u.parentToolUseId) usageByMessage.set(u.messageId, u);
  }

  // 3. SubAgentRun rows — by parentToolUseId, plus run-level orphans.
  const subAgentRows = legacy
    ? await prisma.subAgentRun.findMany({
        where: {
          sessionId: legacySessionId!,
          createdAt: { gte: firstAt, lte: lastAt },
        },
        orderBy: { createdAt: "asc" },
      })
    : await prisma.subAgentRun.findMany({
        where: { runId },
        orderBy: { createdAt: "asc" },
      });
  const toSubNode = (r: (typeof subAgentRows)[number]): SubAgentNode => ({
    id: r.id,
    operation: r.operation,
    model: r.model,
    klass: r.class,
    ok: r.ok,
    outputSchemaName: r.outputSchemaName,
    input: r.input,
    output: r.output,
    error: r.error,
    turns: r.turns,
    createdAt: r.createdAt.toISOString(),
  });
  const subsByTool = new Map<string, SubAgentNode[]>();
  const orphanSubAgents: SubAgentNode[] = [];
  for (const r of subAgentRows) {
    const node = toSubNode(r);
    if (r.parentToolUseId) {
      const arr = subsByTool.get(r.parentToolUseId) ?? [];
      arr.push(node);
      subsByTool.set(r.parentToolUseId, arr);
    } else {
      orphanSubAgents.push(node);
    }
  }

  // 4. PromptSnapshot skeletons for the hashes referenced.
  const hashes = [
    ...new Set(
      usageRows.map((u) => u.systemPromptHash).filter((h): h is string => !!h),
    ),
  ];
  const snapshots = hashes.length
    ? await prisma.promptSnapshot.findMany({
        where: { hash: { in: hashes } },
        select: { hash: true, text: true },
      })
    : [];
  const skeletonByHash = new Map(snapshots.map((s) => [s.hash, s.text]));

  // 5. Tool results by tool_use_id, scanned across all TOOL rows.
  const toolResultById = new Map<
    string,
    { content: string; isError: boolean }
  >();
  for (const m of messages) {
    if (m.role !== "TOOL") continue;
    for (const b of asArray(m.content)) {
      if (!isRecord(b) || b.type !== "tool_result") continue;
      const id = asString(b.tool_use_id);
      if (!id) continue;
      toolResultById.set(id, {
        content: asString(b.content) ?? "",
        isError: b.is_error === true,
      });
    }
  }

  // 6. Owning user.
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  const user = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { email: true, name: true },
      })
    : null;

  // 7. Build the ordered item list.
  const buildLlm = (messageId: string): LlmCallInfo | null => {
    const u = usageByMessage.get(messageId);
    if (!u) return null;
    const rp = isRecord(u.requestParams) ? u.requestParams : null;
    const sp = rp && isRecord(rp.systemPrompt) ? rp.systemPrompt : null;
    const volatile =
      sp && Array.isArray(sp.volatile)
        ? (sp.volatile as { key: string; text: string }[])
        : [];
    const hash = u.systemPromptHash;
    return {
      model: u.model,
      requestParams: u.requestParams,
      systemPrompt:
        hash || volatile.length
          ? {
              hash: hash ?? null,
              skeleton: hash ? (skeletonByHash.get(hash) ?? null) : null,
              volatile,
            }
          : null,
      usage: {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheCreate: u.cacheCreationInputTokens,
        cacheRead: u.cacheReadInputTokens,
        cost: costOf(u),
      },
      notes: u.notes,
    };
  };

  const items: RunItem[] = [];
  for (const m of messages) {
    const blocks = asArray(m.content);
    if (m.role === "USER") {
      items.push({
        kind: "user",
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        text: userText(blocks),
        raw: m.content,
      });
      continue;
    }
    if (m.role === "TOOL") continue; // folded into the preceding turn

    // ASSISTANT: classify status / widget / turn.
    const hasStatus = blocks.some(
      (b) => isRecord(b) && b.type === "pipeline_status",
    );
    const hasWidget = blocks.some(
      (b) => isRecord(b) && b.type === "pipeline_widget",
    );
    const hasError = blocks.some((b) => isRecord(b) && b.type === "run_error");
    const hasTurnContent = blocks.some(
      (b) =>
        isRecord(b) &&
        (b.type === "text" || b.type === "thinking" || b.type === "tool_use"),
    );

    if (!hasTurnContent && hasWidget) {
      for (const b of blocks) {
        if (!isRecord(b) || b.type !== "pipeline_widget") continue;
        items.push({
          kind: "widget",
          id: m.id,
          createdAt: m.createdAt.toISOString(),
          widgetKind: asString(b.kind) ?? "widget",
          payload: b.payload,
        });
      }
      continue;
    }
    if (!hasTurnContent && hasError) {
      for (const b of blocks) {
        if (!isRecord(b) || b.type !== "run_error") continue;
        items.push({
          kind: "error",
          id: m.id,
          createdAt: m.createdAt.toISOString(),
          detail: asString(b.detail) ?? "",
        });
      }
      continue;
    }
    if (!hasTurnContent && hasStatus) {
      const text = blocks
        .filter((b) => isRecord(b) && b.type === "pipeline_status")
        .map((b) => (isRecord(b) ? asString(b.text) : null))
        .filter(Boolean)
        .join("\n");
      items.push({
        kind: "status",
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        text,
      });
      continue;
    }

    // Turn. Build tool calls from tool_use blocks.
    const traceMap = isRecord(m.traces) ? m.traces : null;
    const toolCalls: ToolCallNode[] = [];
    for (const b of blocks) {
      if (!isRecord(b) || b.type !== "tool_use") continue;
      const id = asString(b.id) ?? "";
      const res = id ? toolResultById.get(id) : undefined;
      toolCalls.push({
        toolUseId: id,
        name: asString(b.name) ?? "",
        input: b.input,
        result: res?.content ?? null,
        isError: res?.isError ?? false,
        trace: id && traceMap ? (traceMap[id] ?? null) : null,
        subAgents: id ? (subsByTool.get(id) ?? []) : [],
      });
    }
    items.push({
      kind: "turn",
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      turnIndex: m.turnIndex,
      stoppedByUser: m.stoppedByUser,
      llm: buildLlm(m.id),
      content: blocks,
      toolCalls,
    });
  }

  const tree: RunTree = {
    runId,
    legacy,
    sessionId,
    userId: session?.userId ?? null,
    userEmail: user?.email ?? user?.name ?? null,
    createdAt: firstAt.toISOString(),
    cost: runCost,
    turnCount: items.filter((i) => i.kind === "turn").length,
    items,
    orphanSubAgents,
  };

  return <RunTreeView tree={tree} />;
}
