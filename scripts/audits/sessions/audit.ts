// Session-audit entry point. Resumes from .session-audit-cursor.json,
// pulls the windowed ChatMessages + state, projects per-turn snapshots,
// runs the Opus-driven audit loop (filing AdminNotes as it goes), and
// produces a markdown report.
//
// Usage:
//   pnpm audit:sessions
//   pnpm audit:sessions --dry-run            # don't write AdminNotes or advance cursor
//   pnpm audit:sessions --max-turns 20       # cap (default unlimited)
//   pnpm audit:sessions --model claude-sonnet-4-6   # cheaper alternative to default Opus
//   pnpm audit:sessions --since-iso 2026-06-09T00:00:00Z   # override cursor
//   pnpm audit:sessions --user-email someone@example.com   # different user

import "dotenv/config";
import fs from "fs";
import path from "path";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  PrismaClient,
  type Role,
  type Prisma,
} from "../../../src/generated/prisma/client";

import { runAudit, DEFAULT_MODEL, DEFAULT_CHUNK_SIZE } from "./agent/auditor";
import { attachEntitySnapshots } from "./driver/entitySnapshots";
import { projectTurns } from "./driver/replay";
import { writeReport } from "./report/reportWriter";

// --- Paths -----------------------------------------------------------------

const HERE = __dirname;
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const CURSOR_PATH = path.join(HERE, ".session-audit-cursor.json");
const RUBRIC_PATH = path.join(HERE, "audit-rubric.md");
const HANK_SYSTEM_PATH = path.join(
  REPO_ROOT,
  "src/server/agent/hank/system.ts",
);
// AGENTS.md holds all project conventions; CLAUDE.md is just an @AGENTS.md pointer.
const CLAUDE_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");
const ARTIFACTS_DIR = path.join(HERE, "artifacts");

const DEFAULT_USER_EMAIL = "admin@example.com";

// --- Cursor file -----------------------------------------------------------

type Cursor = {
  sessionId: string;
  lastMessageId: string;
  lastMessageCreatedAt: string;
  lastAuditAt: string;
  lastAuditFindings: number;
  lastAuditModel: string;
  userEmail: string;
};

function readCursor(): Cursor | null {
  if (!fs.existsSync(CURSOR_PATH)) return null;
  return JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
}

function writeCursor(c: Cursor): void {
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(c, null, 2) + "\n");
}

// --- Args ------------------------------------------------------------------

type Args = {
  dryRun: boolean;
  maxTurns: number | null;
  chunkSize: number;
  model: string;
  sinceIso: string | null;
  userEmail: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    maxTurns: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    model: DEFAULT_MODEL,
    sinceIso: null,
    userEmail: DEFAULT_USER_EMAIL,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--max-turns") a.maxTurns = Number(argv[++i]);
    else if (k === "--chunk-size") a.chunkSize = Number(argv[++i]);
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--since-iso") a.sinceIso = argv[++i];
    else if (k === "--user-email") a.userEmail = argv[++i];
  }
  return a;
}

// --- DB --------------------------------------------------------------------

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function dbHost(): string {
  const m = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? "");
  return m?.[1] ?? "(unknown)";
}

async function resolveUser(email: string) {
  const u = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });
  if (!u) throw new Error(`No user found for email=${email}`);
  return u;
}

async function findCurrentSession(userId: string) {
  // Order by max message createdAt — not session startedAt — so ephemeral
  // test sessions (qa-audit / scenarios CLI) with stale or zero messages
  // don't shadow the real session the user actually chats in.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT cs.id
    FROM "ChatSession" cs
    WHERE cs."userId" = ${userId}
      AND EXISTS (SELECT 1 FROM "ChatMessage" cm WHERE cm."sessionId" = cs.id)
    ORDER BY (SELECT MAX("createdAt") FROM "ChatMessage" WHERE "sessionId" = cs.id) DESC NULLS LAST
    LIMIT 1
  `;
  const head = rows[0];
  if (!head)
    throw new Error(`No ChatSession with any messages for userId=${userId}`);
  const s = await prisma.chatSession.findUnique({
    where: { id: head.id },
    select: {
      id: true,
      startedAt: true,
      summary: true,
      summarizedUpToMessageId: true,
      compactedAt: true,
      compactionDeferredCount: true,
    },
  });
  if (!s) throw new Error(`ChatSession ${head.id} vanished between queries`);
  return s;
}

async function pullMessages(sessionId: string, sinceExclusive: Date) {
  return await prisma.chatMessage.findMany({
    where: { sessionId, createdAt: { gt: sinceExclusive } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      createdAt: true,
      content: true,
      traces: true,
      stoppedByUser: true,
    },
  });
}

async function pullExistingAdminNotes(sessionId: string) {
  return await prisma.adminNote.findMany({
    where: { sessionId, dismissed: false },
    select: {
      category: true,
      severity: true,
      summary: true,
      dedupKey: true,
      occurrenceCount: true,
      lastSeenAt: true,
    },
    orderBy: { lastSeenAt: "desc" },
  });
}

async function pullStateSnapshot(userId: string) {
  // Orphan invariant — same query the audit rubric calls out.
  const orphans = await prisma.$queryRaw<
    Array<{
      name: string;
      company_status: string;
      job_status: string;
      count: bigint;
    }>
  >`
    SELECT c.name, ci.status::text AS company_status, ji.status::text AS job_status, COUNT(*)::bigint AS count
    FROM "CompanyInteraction" ci
    JOIN "Company" c ON c.id = ci."companyId"
    JOIN "Job" j ON j."companyId" = c.id
    JOIN "JobInteraction" ji ON ji."jobId" = j.id AND ji."userId" = ci."userId"
    WHERE ci."userId" = ${userId}
      AND ci.status IN ('CLOSED', 'PAUSED')
      AND ji.status IN ('NEW', 'SCANNED', 'SHORTLISTED')
    GROUP BY c.name, ci.status, ji.status
    ORDER BY c.name, ji.status
  `;
  const companies = await prisma.companyInteraction.findMany({
    where: { userId },
    select: {
      companyId: true,
      status: true,
      closeReason: true,
      pauseReason: true,
      company: { select: { name: true } },
    },
  });
  return {
    orphans: orphans.map((o) => ({ ...o, count: Number(o.count) })),
    companyCount: companies.length,
    companiesByStatus: companies.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function buildSessionContextText(args: {
  session: Awaited<ReturnType<typeof findCurrentSession>>;
  state: Awaited<ReturnType<typeof pullStateSnapshot>>;
  windowStartAt: Date;
  windowEndAt: Date;
  turnsCount: number;
  user: { email: string | null; id: string };
}): string {
  const lines: string[] = [];
  lines.push(`User: ${args.user.email} (id=${args.user.id})`);
  lines.push(`Session: ${args.session.id}`);
  lines.push(
    `Window (exclusive start): ${args.windowStartAt.toISOString()} → ${args.windowEndAt.toISOString()}`,
  );
  lines.push(`Turns in window: ${args.turnsCount}`);
  lines.push("");
  lines.push(`ChatSession state at audit time:`);
  lines.push(
    `  compactedAt: ${args.session.compactedAt?.toISOString() ?? "(never)"}`,
  );
  lines.push(
    `  compactionDeferredCount: ${args.session.compactionDeferredCount}`,
  );
  lines.push("");
  lines.push(`Watchlist state:`);
  lines.push(`  total companies: ${args.state.companyCount}`);
  for (const [status, count] of Object.entries(
    args.state.companiesByStatus,
  ).sort()) {
    lines.push(`    ${status}: ${count}`);
  }
  if (args.state.orphans.length) {
    lines.push("");
    lines.push(
      `!! Data integrity flag: ${args.state.orphans.length} (company, job-status) row(s) with mid-flight jobs at a terminal company:`,
    );
    for (const o of args.state.orphans) {
      lines.push(
        `    ${o.name} (company=${o.company_status}) has ${o.count} job(s) at ${o.job_status}`,
      );
    }
  } else {
    lines.push("");
    lines.push(`No orphaned mid-flight jobs at terminal companies.`);
  }
  return lines.join("\n");
}

function buildExistingAdminNotesText(
  rows: Awaited<ReturnType<typeof pullExistingAdminNotes>>,
): string {
  if (rows.length === 0)
    return "(no existing un-dismissed AdminNotes for this session)";
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(
      `- [${r.severity}] (${r.category}) dedupKey=\`${r.dedupKey ?? "(none)"}\` occ=${r.occurrenceCount}: ${r.summary}`,
    );
  }
  return lines.join("\n");
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n== Hank session audit ==`);
  console.log(`  model: ${args.model}`);
  console.log(`  user: ${args.userEmail}`);
  console.log(`  DB: ${dbHost()}`);
  if (args.dryRun)
    console.log(`  --dry-run: no AdminNote writes, no cursor advance`);
  if (args.maxTurns) console.log(`  --max-turns: ${args.maxTurns}`);

  const cursor = readCursor();
  const user = await resolveUser(args.userEmail);
  const currentSession = await findCurrentSession(user.id);

  // Decide window.
  type Pass = {
    label: string;
    sessionId: string;
    sessionRow: Awaited<ReturnType<typeof findCurrentSession>>;
    windowStartAt: Date;
  };
  const passes: Pass[] = [];
  if (args.sinceIso) {
    passes.push({
      label: "explicit-since",
      sessionId: currentSession.id,
      sessionRow: currentSession,
      windowStartAt: new Date(args.sinceIso),
    });
  } else if (!cursor) {
    passes.push({
      label: "first-audit",
      sessionId: currentSession.id,
      sessionRow: currentSession,
      windowStartAt: new Date(0),
    });
  } else if (cursor.sessionId === currentSession.id) {
    passes.push({
      label: "resume",
      sessionId: currentSession.id,
      sessionRow: currentSession,
      windowStartAt: new Date(cursor.lastMessageCreatedAt),
    });
  } else {
    const old = await prisma.chatSession.findUnique({
      where: { id: cursor.sessionId },
      select: {
        id: true,
        startedAt: true,
        summary: true,
        summarizedUpToMessageId: true,
        compactedAt: true,
        compactionDeferredCount: true,
      },
    });
    if (old)
      passes.push({
        label: "tail-of-old-session",
        sessionId: old.id,
        sessionRow: old,
        windowStartAt: new Date(cursor.lastMessageCreatedAt),
      });
    passes.push({
      label: "new-session-from-start",
      sessionId: currentSession.id,
      sessionRow: currentSession,
      windowStartAt: new Date(0),
    });
  }

  // Load static reference text once.
  const rubricMd = fs.readFileSync(RUBRIC_PATH, "utf8");
  const hankSystemMd =
    "```typescript (full source of src/server/agent/hank/system.ts — this IS the rulebook Hank operated under)\n" +
    fs.readFileSync(HANK_SYSTEM_PATH, "utf8") +
    "\n```";
  const claudeMd = fs.readFileSync(CLAUDE_MD_PATH, "utf8");

  let totalFiled = 0;
  let totalBumped = 0;
  let totalCost = 0;

  for (const pass of passes) {
    console.log(`\n── Pass: ${pass.label} ──`);
    console.log(`  session=${pass.sessionId}`);
    console.log(
      `  windowStartAt (exclusive): ${pass.windowStartAt.toISOString()}`,
    );

    const messages = await pullMessages(pass.sessionId, pass.windowStartAt);
    if (messages.length === 0) {
      console.log(`  (nothing new in this pass)`);
      continue;
    }

    type MessageRow = (typeof messages)[number];
    const turns = projectTurns(
      messages.map((m: MessageRow) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        content: m.content,
        traces: m.traces,
        stoppedByUser: m.stoppedByUser,
      })),
    );
    const capped = args.maxTurns ? turns.slice(0, args.maxTurns) : turns;
    // Enrich each turn with the user-visible-but-out-of-chat surface (full
    // drafts, recent activity, notes, memory, company/job attributes), read
    // from current DB state and keyed off the toolcalls/workflow each turn
    // fired. Read-only — never triggers the focus loaders' flip side-effect.
    await attachEntitySnapshots(prisma, user.id, capped);
    console.log(
      `  messages: ${messages.length}  →  turns: ${turns.length}${args.maxTurns ? ` (capped at ${capped.length})` : ""}`,
    );
    console.log(
      `  pre-detected flags across turns: ${capped.reduce((n, t) => n + t.flags.length, 0)}`,
    );
    console.log(
      `  chunk size: ${args.chunkSize}  →  chunks: ${Math.ceil(capped.length / args.chunkSize)}`,
    );

    const [existingAdminNotes, stateSnapshot] = await Promise.all([
      pullExistingAdminNotes(pass.sessionId),
      pullStateSnapshot(user.id),
    ]);

    const windowEndAt =
      capped[capped.length - 1].userMessageAt ??
      messages[messages.length - 1].createdAt;
    const sessionContextText = buildSessionContextText({
      session: pass.sessionRow,
      state: stateSnapshot,
      windowStartAt: pass.windowStartAt,
      windowEndAt,
      turnsCount: capped.length,
      user,
    });
    const existingAdminNotesText =
      buildExistingAdminNotesText(existingAdminNotes);

    // Build a map from turn → last message in that turn, so the per-chunk
    // cursor advance can land on a real message id without re-querying.
    const lastMessageByTurn = new Map<
      number,
      { id: string; createdAt: Date }
    >();
    for (const t of capped) {
      if (t.assistantMessageIds.length > 0) {
        // Last assistant message id is the last persisted message of the turn.
        const lastAssistantId =
          t.assistantMessageIds[t.assistantMessageIds.length - 1];
        // Find its createdAt from the original messages array.
        const m = messages.find((x: MessageRow) => x.id === lastAssistantId);
        if (m)
          lastMessageByTurn.set(t.turnIndex, {
            id: m.id,
            createdAt: m.createdAt,
          });
      } else if (t.userMessageId && t.userMessageAt) {
        lastMessageByTurn.set(t.turnIndex, {
          id: t.userMessageId,
          createdAt: t.userMessageAt,
        });
      }
    }
    // Fallback: last message in the whole window if a chunk somehow has no
    // resolvable last-message (shouldn't happen but defensive).
    const lastMessageInWindow = messages[messages.length - 1];

    const result = await runAudit({
      userId: user.id,
      sessionId: pass.sessionId,
      turns: capped,
      rubricMd,
      hankSystemMd,
      claudeMd,
      existingAdminNotesText,
      sessionContextText,
      artifactsDir: ARTIFACTS_DIR,
      model: args.model,
      chunkSize: args.chunkSize,
      dryRun: args.dryRun,
      onChunkComplete: async ({ chunkIndex, lastTurnInChunk }) => {
        if (args.dryRun) return;
        const lastMsg = lastMessageByTurn.get(lastTurnInChunk.turnIndex) ?? {
          id: lastMessageInWindow.id,
          createdAt: lastMessageInWindow.createdAt,
        };
        const cursor: Cursor = {
          sessionId: pass.sessionId,
          lastMessageId: lastMsg.id,
          lastMessageCreatedAt: lastMsg.createdAt.toISOString(),
          lastAuditAt: new Date().toISOString(),
          lastAuditFindings: 0, // updated at end after we know totals
          lastAuditModel: args.model,
          userEmail: args.userEmail,
        };
        writeCursor(cursor);
        console.log(
          `    cursor advanced (post chunk ${chunkIndex}) → ${lastMsg.id} @ ${lastMsg.createdAt.toISOString()}`,
        );
      },
    });

    totalFiled += result.filed;
    totalBumped += result.bumped;
    totalCost += result.costUsd;

    const reportPath = writeReport({
      artifactsDir: ARTIFACTS_DIR,
      sessionId: pass.sessionId,
      userEmail: user.email ?? args.userEmail,
      windowStartAt: pass.windowStartAt,
      windowEndAt,
      turns: capped,
      chunkResults: result.chunkResults,
      wrapUp: result.wrapUp,
      filed: result.filed,
      bumped: result.bumped,
      costUsd: result.costUsd,
      model: args.model,
      chunkSize: args.chunkSize,
    });
    console.log(`\n  report: ${reportPath}`);
    console.log(`  filed: ${result.filed} new, ${result.bumped} bumps`);
    console.log(`  cost: $${result.costUsd.toFixed(4)}`);

    // Final cursor write at end of pass with the final finding count rolled in.
    if (!args.dryRun) {
      const finalCursor: Cursor = {
        sessionId: pass.sessionId,
        lastMessageId: lastMessageInWindow.id,
        lastMessageCreatedAt: lastMessageInWindow.createdAt.toISOString(),
        lastAuditAt: new Date().toISOString(),
        lastAuditFindings: totalFiled + totalBumped,
        lastAuditModel: args.model,
        userEmail: args.userEmail,
      };
      writeCursor(finalCursor);
      console.log(
        `  cursor finalized → ${finalCursor.lastMessageId} @ ${finalCursor.lastMessageCreatedAt}`,
      );
    }
  }

  console.log(`\n== Done ==`);
  console.log(`  AdminNotes: ${totalFiled} new, ${totalBumped} bumps`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
}

main()
  .catch((e) => {
    console.error("\nFailed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
