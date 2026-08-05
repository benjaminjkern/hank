// Best-effort seed for SubAgentRun from data already on disk, so the first
// runtime audit has something to chew on before forward-capture accumulates.
//
// HONEST SCOPE: most sub-agents never persisted their final output, so their
// history is NOT reconstructable — forward-capture (the recordSubAgentRun call
// inside `runSubAgent`) is the real mechanism. The ONE reconstructable output
// is the
// application decider's: its full decision is cached on JobInteraction.draftDecision.
// We seed those as `seeded:true` rows (input is a reconstruction stub — the real
// prompt was never stored). Shortlist proposals / drafted cover letters survive
// only as free-text inside ChatMessage.content and can't be reliably paired back
// to their inputs, so we deliberately don't fabricate low-fidelity rows for them.
//
// Idempotent: --apply first deletes existing seeded decide_application rows, then
// re-creates. Read-only (dry-run) without --apply.
//
//   pnpm exec tsx scripts/audits/sub-agent-runs/backfill.ts            # dry-run
//   pnpm exec tsx scripts/audits/sub-agent-runs/backfill.ts --apply    # write seeded rows
//   pnpm exec tsx scripts/audits/sub-agent-runs/backfill.ts --apply --limit 200

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, Prisma } from "../../../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function dbHost(): string {
  const m = /@([^/:]+)/.exec(process.env.DATABASE_URL ?? "");
  return m?.[1] ?? "(unknown)";
}

type DecisionShape = { decidedAt?: string } & Record<string, unknown>;

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const limIdx = argv.indexOf("--limit");
  const limit = limIdx !== -1 ? Number(argv[limIdx + 1]) : undefined;

  console.log(
    `\n== SubAgentRun backfill (decide_application from JobInteraction.draftDecision) ==`,
  );
  console.log(`  DB: ${dbHost()}`);
  console.log(
    apply
      ? `  --apply: will write seeded rows`
      : `  dry-run: no writes (pass --apply to write)`,
  );

  const rows = await prisma.jobInteraction.findMany({
    where: { draftDecision: { not: Prisma.DbNull } },
    select: {
      userId: true,
      jobId: true,
      draftDecision: true,
      updatedAt: true,
      job: { select: { title: true, enrichedSummary: true } },
    },
    ...(limit ? { take: limit } : {}),
  });
  console.log(
    `  found ${rows.length} JobInteraction row(s) with a cached decision`,
  );

  if (!apply) {
    for (const r of rows.slice(0, 10)) {
      console.log(
        `    would seed decide_application: job="${r.job.title}" user=${r.userId}`,
      );
    }
    if (rows.length > 10) console.log(`    … and ${rows.length - 10} more`);
    console.log(`\n  (dry-run) nothing written. Re-run with --apply.`);
    return;
  }

  const deleted = await prisma.subAgentRun.deleteMany({
    where: { seeded: true, operation: "application_decider" },
  });
  console.log(
    `  cleared ${deleted.count} existing seeded decide_application row(s)`,
  );

  let written = 0;
  for (const r of rows) {
    const decision = (r.draftDecision ?? {}) as DecisionShape;
    const decidedAt =
      typeof decision.decidedAt === "string"
        ? new Date(decision.decidedAt)
        : r.updatedAt;
    await prisma.subAgentRun.create({
      data: {
        userId: r.userId,
        sessionId: null,
        operation: "application_decider",
        model: "unknown (reconstructed)",
        class: "judgement",
        ok: true,
        outputSchemaName: "commit_decision",
        input: {
          reconstructed: true,
          note: "Original prompt was not captured (pre-instrumentation). Reconstructed context below.",
          jobTitle: r.job.title,
          jobEnrichedSummary: r.job.enrichedSummary ?? null,
        },
        output: decision as Prisma.InputJsonValue,
        seeded: true,
        createdAt: decidedAt,
      },
    });
    written++;
  }
  console.log(
    `\n== Done ==\n  wrote ${written} seeded decide_application row(s)`,
  );
}

main()
  .catch((e) => {
    console.error("\nFailed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
