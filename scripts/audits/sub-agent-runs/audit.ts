// Sub-agent runtime audit entry point.
//
// Audits the REAL production outputs of Hank's sub-agents. Reads new SubAgentRun
// rows since the last audit (per-operation cursor), and for each operation has
// Opus judge whether each real response was weird AND whether its use-case shape
// is covered by that sub-agent's static fixtures (scripts/regression/sub-agents/) —
// filing AdminNotes for both. Companion to session-audit (which audits the
// user-visible chat surface) and the static sub-agent-audits (fixtures).
//
// Usage:
//   pnpm audit:sub-agent-runs
//   pnpm audit:sub-agent-runs --dry-run                 # no AdminNotes, no cursor advance
//   pnpm audit:sub-agent-runs --only shortlist_jobs     # one operation
//   pnpm audit:sub-agent-runs --since-iso 2026-06-20T00:00:00Z   # ignore cursor, start from date
//   pnpm audit:sub-agent-runs --chunk-size 8 --model claude-sonnet-4-6
//
// Hits whatever DATABASE_URL points at (prod, per CLAUDE.md). --dry-run is
// zero-spend, zero-write. See scripts/audits/sub-agent-runs/README.md.

import "dotenv/config";
import fs from "fs";
import path from "path";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { getGraderClient } from "../../lib/graderLlm";

import {
  DEFAULT_MODEL,
  DEFAULT_CHUNK_SIZE,
  runOperationAudit,
  type OperationAuditResult,
} from "./agent/auditor";
import {
  listOperationsWithRuns,
  loadNewRuns,
  resolveFallbackSession,
  type SubAgentRunRow,
} from "./driver/loadRuns";
import { fixturesForOperation } from "./fixtureRegistry";
import { writeReport } from "./report/reportWriter";

const HERE = __dirname;
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const CURSOR_PATH = path.join(HERE, ".subagent-runtime-audit-cursor.json");
const RUBRIC_PATH = path.join(HERE, "rubric.md");
const SUBAGENTS_DOC_PATH = path.join(REPO_ROOT, "docs/sub-agents.md");
const ARTIFACTS_DIR = path.join(HERE, "artifacts");
const DEFAULT_AUDIT_USER_EMAIL = "admin@example.com";

// --- Cursor: one entry per operation ---------------------------------------

type OperationCursor = { lastRunId: string; lastRunCreatedAt: string };
type Cursor = {
  lastAuditAt: string;
  lastAuditModel: string;
  lastAuditFindings: number;
  perOperation: Record<string, OperationCursor>;
};

function readCursor(): Cursor {
  if (!fs.existsSync(CURSOR_PATH)) {
    return {
      lastAuditAt: "",
      lastAuditModel: "",
      lastAuditFindings: 0,
      perOperation: {},
    };
  }
  return JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8")) as Cursor;
}
function writeCursor(c: Cursor): void {
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(c, null, 2) + "\n");
}

// --- Args ------------------------------------------------------------------

type Args = {
  dryRun: boolean;
  only: string[];
  sinceIso: string | null;
  chunkSize: number;
  model: string;
  auditUserEmail: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    only: [],
    sinceIso: null,
    chunkSize: DEFAULT_CHUNK_SIZE,
    model: DEFAULT_MODEL,
    auditUserEmail: DEFAULT_AUDIT_USER_EMAIL,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--only")
      a.only = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (k === "--since-iso") a.sinceIso = argv[++i];
    else if (k === "--chunk-size") a.chunkSize = Number(argv[++i]);
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--audit-user-email") a.auditUserEmail = argv[++i];
    // --live is accepted for muscle-memory but not required (mirrors session-audit).
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

function nowIso(): string {
  return new Date().toISOString();
}

async function resolveAuditUser(email: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (u) return u.id;
  // Fallback: first admin. The audit user only owns the audit's own Opus token
  // usage rows; findings are filed under each run's real user.
  const admin = await prisma.user.findFirst({
    where: { isAdmin: true },
    select: { id: true },
  });
  if (!admin)
    throw new Error(
      `No user for email=${email} and no admin user to attribute audit usage to`,
    );
  return admin.id;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n== Hank sub-agent runtime audit ==`);
  console.log(`  model: ${args.model} · chunk size: ${args.chunkSize}`);
  console.log(`  DB: ${dbHost()}`);
  if (args.dryRun)
    console.log(`  --dry-run: no AdminNote writes, no cursor advance`);
  if (args.only.length) console.log(`  --only: ${args.only.join(", ")}`);
  if (args.sinceIso)
    console.log(`  --since-iso: ${args.sinceIso} (ignoring cursor)`);

  // Grader client: real Anthropic (API key) or the subscription shim (Agent
  // SDK), chosen by graderBackend(). On the subscription path the API key is
  // ignored, so it's fine (not required) for it to be absent here.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = getGraderClient(apiKey ? new Anthropic({ apiKey }) : null);

  const rubricMd = fs.readFileSync(RUBRIC_PATH, "utf8");
  const subAgentsDocMd = fs.readFileSync(SUBAGENTS_DOC_PATH, "utf8");
  const auditUserId = await resolveAuditUser(args.auditUserEmail);

  const cursor = readCursor();
  let operations = await listOperationsWithRuns(prisma);
  if (args.only.length)
    operations = operations.filter((op) => args.only.includes(op));
  if (operations.length === 0) {
    console.log(
      `\n  No SubAgentRun rows${args.only.length ? " for the requested operation(s)" : ""}. Nothing to audit.`,
    );
    return;
  }

  const results: OperationAuditResult[] = [];
  let totalRuns = 0;
  let totalCost = 0;

  for (const operation of operations) {
    const since = args.sinceIso
      ? new Date(args.sinceIso)
      : cursor.perOperation[operation]
        ? new Date(cursor.perOperation[operation].lastRunCreatedAt)
        : null;
    const runs = await loadNewRuns(prisma, operation, since);
    if (runs.length === 0) {
      continue;
    }
    const entry = fixturesForOperation(operation);
    console.log(
      `\n▶ ${operation} — ${runs.length} new run(s)${entry ? ` · ${entry.fixtures.length} fixture(s)` : " · NO static fixtures (all coverage gaps)"}`,
    );
    totalRuns += runs.length;

    const result = await runOperationAudit({
      client,
      model: args.model,
      auditUserId,
      operation,
      entry,
      runs,
      rubricMd,
      subAgentsDocMd,
      chunkSize: args.chunkSize,
      dryRun: args.dryRun,
      artifactsDir: ARTIFACTS_DIR,
      sessionResolver: (userId: string) =>
        resolveFallbackSession(prisma, userId),
      onChunkComplete: ({
        lastRunInChunk,
      }: {
        chunkIndex: number;
        lastRunInChunk: SubAgentRunRow;
      }) => {
        if (args.dryRun) return;
        cursor.perOperation[operation] = {
          lastRunId: lastRunInChunk.id,
          lastRunCreatedAt: lastRunInChunk.createdAt.toISOString(),
        };
        cursor.lastAuditAt = nowIso();
        cursor.lastAuditModel = args.model;
        writeCursor(cursor);
      },
    });
    results.push(result);
    totalCost += result.costUsd;
    console.log(
      `  ${operation}: filed ${result.filed} new, ${result.bumped} bumps · cost $${result.costUsd.toFixed(4)}`,
    );
  }

  if (results.length === 0) {
    console.log(`\n  No new runs to audit since the last cursor. Done.`);
    return;
  }

  const totalFiled = results.reduce((n, r) => n + r.filed, 0);
  const totalBumped = results.reduce((n, r) => n + r.bumped, 0);
  if (!args.dryRun) {
    cursor.lastAuditFindings = totalFiled + totalBumped;
    cursor.lastAuditAt = nowIso();
    writeCursor(cursor);
  }

  const reportPath = writeReport({
    artifactsDir: ARTIFACTS_DIR,
    runAtIso: nowIso(),
    model: args.model,
    chunkSize: args.chunkSize,
    dbHost: dbHost(),
    results,
    totalRuns,
    totalCost,
  });

  console.log(`\n== Done ==`);
  console.log(`  operations: ${results.length} · runs: ${totalRuns}`);
  console.log(`  AdminNotes: ${totalFiled} new, ${totalBumped} bumps`);
  console.log(`  cost: $${totalCost.toFixed(4)}`);
  console.log(`  report: ${reportPath}`);
}

main()
  .catch((e) => {
    console.error("\nFailed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
