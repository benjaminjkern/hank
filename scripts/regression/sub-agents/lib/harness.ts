// Shared driver for the sub-agent audit scripts.
//
// The original six audits (shortlist-jobs, pre-scan, discovery-search,
// company-basic-info, memory-consolidation, application-drafting) each inline
// the same ~50 lines of main()/DB-guard/report-append boilerplate. The 2026-06
// batch (the two unaudited judgement sub-agents + the six transform sub-agents)
// hoists that boilerplate here so each new script is just FIXTURES + RUBRIC +
// runOneCase. The old six still work unchanged — this is additive.
//
// All audit DB access is read-only (or dryRun); recordUsage rows + a markdown
// report under docs/audits/ are the only writes, matching the existing scripts.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../../src/server/platform/llm/resolveAnthropicKey";

import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./report";

export const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
export const prisma = new PrismaClient({ adapter });

export function isLocalHost(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function glyph(v: string): string {
  return v === "pass" ? "✓" : v === "fail" ? "✗" : "⚠";
}

export function dbHost(): string {
  return (
    (process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "(unknown)"
  );
}

// Refuse to run against a non-localhost DB unless --live is explicitly passed.
// Every audit is read-only / dryRun, but reading live data silently picks the
// wrong fixtures (slugs/jobs that only exist in one DB) — fail loud instead.
export function assertDbAllowed(): string {
  const host = dbHost();
  const allowLive = process.argv.includes("--live");
  if (!isLocalHost(host) && !allowLive) {
    throw new Error(
      `DATABASE_URL points at non-local host "${host}". Re-run with --live to allow.`,
    );
  }
  return host;
}

export type AuditCtx = {
  userId: string;
  userEmail: string;
  sessionId: string;
  judgeClient: Anthropic;
};

// Resolve the host user (SEED_ADMIN_EMAIL or the first admin), an active
// ChatSession to attribute usage to, and a judge client keyed by that user.
export async function resolveAuditCtx(): Promise<AuditCtx> {
  // AUDIT_USER_EMAIL pins the audits at a specific user (the prod test user);
  // falls back to SEED_ADMIN_EMAIL, then the first admin.
  const email = process.env.AUDIT_USER_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      })
    : await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, email: true },
      });
  if (!user) {
    throw new Error(
      "No admin user found (set SEED_ADMIN_EMAIL in .env or seed an admin)",
    );
  }
  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session)
    throw new Error(`no active ChatSession for ${user.email ?? user.id}`);
  const judgeClient = new Anthropic({
    apiKey: await resolveAnthropicApiKey(user.id),
  });
  return {
    userId: user.id,
    userEmail: user.email ?? "(no email)",
    sessionId: session.id,
    judgeClient,
  };
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const { readFile } = await import("fs/promises");
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// Append this run's cases to the day's report file (creating it if absent), so
// run-all's sequential audits accumulate into one docs/audits/<date>.md.
export async function appendRunReport(
  runId: string,
  startedAt: string,
  cases: CaseReport[],
): Promise<string> {
  const run: RunReport = { runId, startedAt, cases };
  const reportPath = `docs/audits/sub-agent-audit-${startedAt}.md`;
  const existing = await readFileIfExists(reportPath);
  const content =
    existing && existing.includes("# Sub-agent audit report")
      ? existing +
        "\n\n---\n\n" +
        renderRunReport(run).split("\n").slice(2).join("\n")
      : renderRunReport(run);
  await writeReport(reportPath, content);
  return reportPath;
}

function nowMs(): number {
  return Date.now();
}

export type AuditConfig<F> = {
  subAgentName: string;
  fixtures: F[];
  // One-line label printed as the fixture runs.
  fixtureLabel: (fixture: F) => string;
  // Build the CaseReport for one fixture (run sub-agent in dryRun, build
  // context/output markdown, call runJudge). durationMs is filled by the
  // driver — return 0.
  runCase: (fixture: F, ctx: AuditCtx) => Promise<CaseReport>;
};

// The shared per-script main(): DB guard → resolve ctx → loop fixtures →
// append report → print the "Total judge cost: $X" line run-all parses.
export async function runAudit<F>(config: AuditConfig<F>): Promise<void> {
  const host = assertDbAllowed();
  process.stdout.write(`DB: ${host}\n`);
  const ctx = await resolveAuditCtx();

  const startedAt = new Date().toISOString().slice(0, 10);
  const runId = `audit-${nowMs().toString(36)}`;
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — ${config.subAgentName}\n` +
      `Run ID: ${runId}\nFixtures: ${config.fixtures.length}\nUser: ${ctx.userEmail}\n\n`,
  );

  for (const fx of config.fixtures) {
    const t0 = nowMs();
    process.stdout.write(`▶ ${config.fixtureLabel(fx)}\n`);
    try {
      const cr = await config.runCase(fx, ctx);
      cr.durationMs = nowMs() - t0;
      cases.push(cr);
      process.stdout.write(
        `   ${glyph(cr.judge.verdict)} ${cr.judge.verdict.toUpperCase()} score=${cr.judge.score}/5 ` +
          `(${(cr.durationMs / 1000).toFixed(1)}s, judge $${cr.judgeUsdCost.toFixed(3)})\n` +
          `   ${cr.judge.rationale.split("\n")[0].slice(0, 180)}\n\n`,
      );
    } catch (err) {
      process.stdout.write(
        `   ✗ ERROR: ${err instanceof Error ? err.message : String(err)}\n\n`,
      );
    }
  }

  const reportPath = await appendRunReport(runId, startedAt, cases);
  const totalJudge = cases.reduce((s, c) => s + c.judgeUsdCost, 0);
  process.stdout.write(
    `\nReport: ${reportPath}\nTotal judge cost: $${totalJudge.toFixed(3)}\n`,
  );
}
