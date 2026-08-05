// Audit-time, READ-ONLY reconstruction of the user-visible surface that lives
// OUTSIDE the chat stream.
//
// The session-audit replay (driver/replay.ts) only projects what's in the chat:
// ChatMessage content + sub-agent traces. But a user also sees, in the right
// panel / Documents view, things that never appear in chat — the FULL drafted
// cover letters & short answers, recent-activity events, company/job notes, the
// memory/document files, and company/job descriptions + attributes. The auditor
// has to judge against the same information the user had, so this module fills
// those in.
//
// "Generated on the fly" (per the spec): we never persist snapshots. For each
// turn we look at the toolcalls / workflow it triggered, work out which entities
// it touched, and read their CURRENT state from the DB at audit time. This
// mirrors exactly what the focus panel renders (getFocusedJobView /
// getFocusedCompanyView) — minus the write side-effects those loaders carry
// (flipDueInterviewsToDebrief), which an audit must never trigger. Because state
// is read at audit time, a draft/note shown at the turn that created it is the
// LATEST version (fine — it's what the user sees now); the as-generated copy is
// still in that turn's truncated tool I/O.
//
// Per-job description uses Job.enrichedSummary (not the raw posting) per the
// spec — the compact user-facing summary, which also keeps the auditor input
// from ballooning with full JD text.

import type { PrismaClient } from "@/generated/prisma/client";
import {
  ROLE_ATTR_SELECT,
  formatRoleAttrs,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";

import type { AuditTurn } from "./replay";

// Noise events that dominate the feed (one per scrape / per detail-read). The
// real company timeline excludes them too (getFocusedCompanyView).
const EXCLUDED_EVENT_TYPES = ["SURFACED", "SCANNED"] as const;
const JOB_EVENTS_LIMIT = 20;
const COMPANY_EVENTS_LIMIT = 25;
// The full cover letter / short answers are the whole point — show them whole.
// Memory files (esp. frequent_questions.md ~9KB) and freeform notes get a
// generous cap so a single turn's snapshot can't balloon the auditor input.
const MEMORY_CAP = 6000;
const NOTE_CAP = 2500;
const DESCRIPTION_CAP = 1500;

type EntityRefs = {
  jobIds: Set<string>;
  companyIds: Set<string>;
  memoryPaths: Set<string>;
};

function emptyRefs(): EntityRefs {
  return { jobIds: new Set(), companyIds: new Set(), memoryPaths: new Set() };
}

// Recursively pull entity references out of a toolcall / trace input object.
// Keyed on the conventional field names the tools use (jobId, companyId,
// jobIds[], path) — generic so we don't have to enumerate every tool.
function scanRefs(value: unknown, refs: EntityRefs): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) scanRefs(v, refs);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v) {
      if (k === "jobId") refs.jobIds.add(v);
      else if (k === "companyId") refs.companyIds.add(v);
      else if (k === "path") refs.memoryPaths.add(v);
    } else if (k === "jobIds" && Array.isArray(v)) {
      for (const id of v) if (typeof id === "string" && id) refs.jobIds.add(id);
    } else if (v && typeof v === "object") {
      scanRefs(v, refs);
    }
  }
}

// Walk a sub-agent trace ({ steps: [...] }) and scan every tool step's input —
// catches write_memory / read_reusable_application / set_focus done inside a
// sub-agent loop (e.g. the drafting sub-agent reading a past application).
function scanTraceRefs(raw: unknown, refs: EntityRefs): void {
  const steps = (raw as { steps?: unknown[] })?.steps;
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.kind === "tool") {
      if (s.input !== undefined) scanRefs(s.input, refs);
      if (Array.isArray(s.children)) scanTraceRefs({ steps: s.children }, refs);
    }
  }
}

function traceHasTool(raw: unknown, name: string): boolean {
  const steps = (raw as { steps?: unknown[] })?.steps;
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.kind === "tool" && s.name === name) return true;
    if (
      s.kind === "tool" &&
      Array.isArray(s.children) &&
      traceHasTool({ steps: s.children }, name)
    )
      return true;
  }
  return false;
}

// A turn drafted something if it called draft_application, narrated "Drafting…",
// or a sub-agent committed a draft — used to attach the focused job to the
// automatic walkthrough draft, which carries no explicit jobId in chat.
function turnHasDraftingSignal(turn: AuditTurn): boolean {
  if (turn.toolCalls.some((c) => c.name === "draft_application")) return true;
  if (turn.statusLines.some((s) => /drafting/i.test(s))) return true;
  return turn.subAgentTraces.some((t) => traceHasTool(t.raw, "commit_draft"));
}

// Per-turn entity refs, with a running focus cursor so a turn that operates on
// the *focused* entity without re-naming its id (the walkthrough draft) still
// gets its snapshot. Last-id-in-turn wins the cursor.
function collectTurnRefs(
  turns: AuditTurn[],
  nameToCompanyId: Map<string, string>,
): Map<number, EntityRefs> {
  const out = new Map<number, EntityRefs>();
  let focusJobId: string | null = null;
  let focusCompanyId: string | null = null;

  for (const turn of turns) {
    const refs = emptyRefs();
    for (const c of turn.toolCalls) {
      scanRefs(c.input, refs);
      // company_walkthrough targets a company by NAME, not id — resolve it.
      if (c.name === "company_walkthrough") {
        const name = (c.input as { companyName?: unknown })?.companyName;
        if (typeof name === "string") {
          const id = nameToCompanyId.get(name.trim().toLowerCase());
          if (id) refs.companyIds.add(id);
        }
      }
    }
    for (const t of turn.subAgentTraces) scanTraceRefs(t.raw, refs);

    // Advance the focus cursor from whatever this turn touched.
    for (const id of refs.companyIds) focusCompanyId = id;
    for (const id of refs.jobIds) focusJobId = id;

    // Walkthrough draft / status with no explicit job → attach the focused job.
    if (refs.jobIds.size === 0 && focusJobId && turnHasDraftingSignal(turn)) {
      refs.jobIds.add(focusJobId);
    }

    if (refs.jobIds.size || refs.companyIds.size || refs.memoryPaths.size) {
      out.set(turn.turnIndex, refs);
    }
  }
  return out;
}

function cap(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n) + " …(truncated)";
}

function indentBlock(text: string, n = 2): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function reasonSuffix(parts: Array<string | null | undefined>): string {
  const live = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return live.length ? ` · ${live.join(" · ")}` : "";
}

async function loadJobText(
  prisma: PrismaClient,
  userId: string,
  jobId: string,
): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      title: true,
      companyName: true,
      enrichedSummary: true,
      ...ROLE_ATTR_SELECT,
      company: { select: { name: true } },
      jobInteractions: {
        where: { userId },
        take: 1,
        select: {
          status: true,
          closeReason: true,
          closeNote: true,
          deferReason: true,
          deferNote: true,
          coverLetter: true,
          coverLetterReuse: true,
          shortAnswers: true,
          events: {
            where: { type: { notIn: [...EXCLUDED_EVENT_TYPES] } },
            orderBy: { occurredAt: "desc" },
            take: JOB_EVENTS_LIMIT,
            select: { type: true, occurredAt: true, notes: true },
          },
        },
      },
    },
  });
  if (!job) return null;
  const note = await prisma.memoryNote.findUnique({
    where: { userId_path: { userId, path: `jobs/${jobId}.md` } },
    select: { content: true },
  });

  const company = job.company?.name ?? job.companyName ?? "(unknown company)";
  const i = job.jobInteractions[0];
  const lines: string[] = [];
  lines.push(`JOB "${job.title}" @ ${company} (jobId=${jobId})`);

  const attrs = formatRoleAttrs(toRoleAttrs(job));
  if (attrs) lines.push(indentBlock(attrs));

  if (i) {
    lines.push(
      indentBlock(
        `status: ${i.status}${reasonSuffix([
          i.closeReason && `close:${i.closeReason}`,
          i.closeNote,
          i.deferReason && `defer:${i.deferReason}`,
          i.deferNote,
        ])}`,
      ),
    );
  }

  lines.push(
    indentBlock(
      `enriched summary: ${job.enrichedSummary ? job.enrichedSummary.trim() : "(not enriched yet)"}`,
    ),
  );

  if (i) {
    // FULL cover letter — untruncated; this is the whole point of the snapshot.
    if (i.coverLetter && i.coverLetter.trim()) {
      const reuse = i.coverLetterReuse === true ? "reusable" : "not reusable";
      lines.push(
        indentBlock(`cover letter (${i.coverLetter.length} chars · ${reuse}):`),
      );
      lines.push(indentBlock(i.coverLetter.trim(), 4));
    } else {
      lines.push(indentBlock(`cover letter: (none)`));
    }

    const sa = Array.isArray(i.shortAnswers)
      ? (i.shortAnswers as Array<{ question?: string; answer?: string }>)
      : [];
    if (sa.length) {
      lines.push(indentBlock(`short answers (${sa.length}):`));
      for (const a of sa) {
        if (!a?.question && !a?.answer) continue;
        lines.push(indentBlock(`Q: ${a.question ?? "(no question)"}`, 4));
        lines.push(indentBlock(`A: ${a.answer ?? "(no answer)"}`, 4));
      }
    }

    if (i.events.length) {
      lines.push(indentBlock(`recent activity (${i.events.length} shown):`));
      for (const e of i.events) {
        lines.push(
          indentBlock(
            `- ${e.type} @ ${fmt(e.occurredAt)}${e.notes ? ` — ${e.notes}` : ""}`,
            4,
          ),
        );
      }
    }
  }

  if (note?.content?.trim()) {
    lines.push(indentBlock(`job note (jobs/${jobId}.md):`));
    lines.push(indentBlock(cap(note.content, NOTE_CAP), 4));
  }

  return lines.join("\n");
}

async function loadCompanyText(
  prisma: PrismaClient,
  userId: string,
  companyId: string,
): Promise<string | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      name: true,
      slug: true,
      description: true,
      companyInteractions: {
        where: { userId },
        take: 1,
        select: {
          status: true,
          closeReason: true,
          closeNote: true,
          pauseReason: true,
          pauseNote: true,
          blockReason: true,
          blockNote: true,
        },
      },
      jobs: {
        select: {
          title: true,
          jobInteractions: {
            where: { userId },
            take: 1,
            select: {
              status: true,
              events: {
                where: { type: { notIn: [...EXCLUDED_EVENT_TYPES] } },
                orderBy: { occurredAt: "desc" },
                take: COMPANY_EVENTS_LIMIT,
                select: { type: true, occurredAt: true, notes: true },
              },
            },
          },
        },
      },
    },
  });
  if (!company) return null;
  const note = await prisma.memoryNote.findUnique({
    where: { userId_path: { userId, path: `companies/${company.slug}.md` } },
    select: { content: true },
  });

  const companyInteraction = company.companyInteractions[0];
  const lines: string[] = [];
  lines.push(`COMPANY ${company.name} (companyId=${companyId})`);
  if (companyInteraction) {
    lines.push(
      indentBlock(
        `status: ${companyInteraction.status}${reasonSuffix([
          companyInteraction.closeReason &&
            `close:${companyInteraction.closeReason}`,
          companyInteraction.closeNote,
          companyInteraction.pauseReason &&
            `pause:${companyInteraction.pauseReason}`,
          companyInteraction.pauseNote,
          companyInteraction.blockReason &&
            `block:${companyInteraction.blockReason}`,
          companyInteraction.blockNote,
        ])}`,
      ),
    );
  }
  lines.push(
    indentBlock(
      `description: ${company.description ? cap(company.description, DESCRIPTION_CAP) : "(none)"}`,
    ),
  );

  // Recent activity across the company's jobs — mirrors the panel timeline.
  const events = company.jobs
    .flatMap((j) =>
      (j.jobInteractions[0]?.events ?? []).map((e) => ({
        type: e.type,
        occurredAt: e.occurredAt,
        notes: e.notes,
        jobTitle: j.title,
      })),
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, COMPANY_EVENTS_LIMIT);
  if (events.length) {
    lines.push(indentBlock(`recent activity (${events.length} shown):`));
    for (const e of events) {
      lines.push(
        indentBlock(
          `- ${e.type} @ ${fmt(e.occurredAt)} — ${e.jobTitle}${e.notes ? ` — ${e.notes}` : ""}`,
          4,
        ),
      );
    }
  }

  if (note?.content?.trim()) {
    lines.push(indentBlock(`company note (companies/${company.slug}.md):`));
    lines.push(indentBlock(cap(note.content, NOTE_CAP), 4));
  }

  return lines.join("\n");
}

async function loadMemoryText(
  prisma: PrismaClient,
  userId: string,
  path: string,
): Promise<string | null> {
  const note = await prisma.memoryNote.findUnique({
    where: { userId_path: { userId, path } },
    select: { content: true },
  });
  if (!note) return `MEMORY ${path}: (no such note — write may have failed)`;
  return `MEMORY ${path} (current content, ${note.content.length} chars):\n${indentBlock(cap(note.content, MEMORY_CAP))}`;
}

// Populate turn.entitySnapshot for every turn whose toolcalls/workflow touched
// a job, company, or memory file. Read-only: no writes, no flip side-effects.
export async function attachEntitySnapshots(
  prisma: PrismaClient,
  userId: string,
  turns: AuditTurn[],
): Promise<void> {
  // name → companyId, for resolving company_walkthrough({companyName}).
  const companyInteractions = await prisma.companyInteraction.findMany({
    where: { userId },
    select: { company: { select: { id: true, name: true } } },
  });
  const nameToCompanyId = new Map<string, string>();
  for (const { company } of companyInteractions) {
    if (company)
      nameToCompanyId.set(company.name.trim().toLowerCase(), company.id);
  }

  const refsByTurn = collectTurnRefs(turns, nameToCompanyId);
  if (refsByTurn.size === 0) return;

  // Unique entities across the whole window — load each exactly once.
  const allJobIds = new Set<string>();
  const allCompanyIds = new Set<string>();
  const allPaths = new Set<string>();
  for (const refs of refsByTurn.values()) {
    refs.jobIds.forEach((j) => allJobIds.add(j));
    refs.companyIds.forEach((c) => allCompanyIds.add(c));
    refs.memoryPaths.forEach((p) => allPaths.add(p));
  }

  const jobText = new Map<string, string>();
  const companyText = new Map<string, string>();
  const memoryText = new Map<string, string>();
  await Promise.all([
    ...[...allJobIds].map(async (id) => {
      const t = await loadJobText(prisma, userId, id);
      if (t) jobText.set(id, t);
    }),
    ...[...allCompanyIds].map(async (id) => {
      const t = await loadCompanyText(prisma, userId, id);
      if (t) companyText.set(id, t);
    }),
    ...[...allPaths].map(async (p) => {
      const t = await loadMemoryText(prisma, userId, p);
      if (t) memoryText.set(p, t);
    }),
  ]);

  for (const turn of turns) {
    const refs = refsByTurn.get(turn.turnIndex);
    if (!refs) continue;
    const blocks: string[] = [];
    for (const id of refs.companyIds) {
      const t = companyText.get(id);
      if (t) blocks.push(t);
    }
    for (const id of refs.jobIds) {
      const t = jobText.get(id);
      if (t) blocks.push(t);
    }
    for (const p of refs.memoryPaths) {
      const t = memoryText.get(p);
      if (t) blocks.push(t);
    }
    if (blocks.length) turn.entitySnapshot = blocks.join("\n\n");
  }
}
