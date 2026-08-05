// Shared AdminNote upsert. The ONLY write paths are the two offline audit
// harnesses (scripts/audits/sessions/ + scripts/audits/sub-agent-runs/); no
// runtime agent or sub-agent writes AdminNotes. Any future writer still goes
// through this one helper.
//
// Why a helper instead of inline create calls: the schema supports dedup via
// (userId, category, dedupKey, dismissed=false). Inlining the match-or-insert
// dance at every call site would drift; centralising it keeps the contract
// single-sourced.

import { Role } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export type AdminNoteCategory =
  | "user_confusion"
  | "agent_confusion"
  | "flow_friction"
  | "capability_request"
  | "tool_misbehavior"
  | "self_improvement"
  // Browser-side failure reported via /api/client-events: SSE
  // disconnect, render crash, widget failure, no-credit/invalid-key modal.
  // Not agent-written — fanned out from ClientEvent rows.
  | "client_error";

export const ADMIN_NOTE_CATEGORIES: readonly AdminNoteCategory[] = [
  "user_confusion",
  "agent_confusion",
  "flow_friction",
  "capability_request",
  "tool_misbehavior",
  "self_improvement",
  "client_error",
] as const;

export type AdminNoteSeverity = "LOW" | "MEDIUM" | "HIGH";

const SEVERITY_RANK: Record<AdminNoteSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

type UpsertAdminNoteArgs = {
  userId: string;
  sessionId: string;
  category: AdminNoteCategory;
  summary: string;
  // Long-form context for the finding. Same column whatever the caller labels it.
  context?: string | null;
  // Optional severity. Defaults to MEDIUM on insert. On dedup-bump, we keep
  // the existing row's severity unless the incoming value is higher (a
  // severe re-occurrence escalates a previously-mild observation).
  severity?: AdminNoteSeverity;
  // Optional dedup key. When present, a matching (userId, category, dedupKey,
  // dismissed=false) row is bumped instead of a new row inserted.
  // Recommended shape: `<source>:<failure mode>:<input shape>` e.g.
  // `get_application_form:unsupported:greenhouse`.
  dedupKey?: string | null;
  // Optional pre-resolved messageId. If omitted, we look up the user's most
  // recent ChatMessage on this session at write time (matches legacy behavior).
  messageId?: string | null;
};

type UpsertAdminNoteResult = {
  id: string;
  // true = an existing row was bumped (occurrenceCount += 1); false = inserted
  bumped: boolean;
};

export async function upsertAdminNote(
  args: UpsertAdminNoteArgs,
): Promise<UpsertAdminNoteResult> {
  const messageId = await resolveMessageId(args);
  const severity: AdminNoteSeverity = args.severity ?? "MEDIUM";
  const dedupKey = args.dedupKey ?? null;

  if (dedupKey) {
    const existing = await prisma.adminNote.findFirst({
      where: {
        userId: args.userId,
        category: args.category,
        dedupKey,
        dismissed: false,
      },
      // Newest first — if two non-dismissed rows ever match (shouldn't happen
      // under normal flow, but harmless), bump the most recent.
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, severity: true },
    });
    if (existing) {
      const existingSev = (existing.severity as AdminNoteSeverity) ?? "MEDIUM";
      const newSev: AdminNoteSeverity =
        SEVERITY_RANK[severity] > SEVERITY_RANK[existingSev]
          ? severity
          : existingSev;
      const updated = await prisma.adminNote.update({
        where: { id: existing.id },
        data: {
          occurrenceCount: { increment: 1 },
          lastSeenAt: new Date(),
          severity: newSev,
          // Refresh summary/context to the latest framing — a re-occurrence
          // often has better wording than the first capture, and we're showing
          // one row in /admin/notes regardless.
          summary: args.summary,
          context: args.context ?? null,
        },
        select: { id: true },
      });
      return { id: updated.id, bumped: true };
    }
  }

  const created = await prisma.adminNote.create({
    data: {
      userId: args.userId,
      sessionId: args.sessionId,
      messageId,
      category: args.category,
      summary: args.summary,
      context: args.context ?? null,
      severity,
      dedupKey,
    },
    select: { id: true },
  });
  return { id: created.id, bumped: false };
}

async function resolveMessageId(
  args: UpsertAdminNoteArgs,
): Promise<string | null> {
  if (args.messageId !== undefined) return args.messageId;
  const latestUserMessage = await prisma.chatMessage.findFirst({
    where: { sessionId: args.sessionId, role: Role.USER },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return latestUserMessage?.id ?? null;
}
