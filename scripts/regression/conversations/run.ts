// QA-audit harness entrypoint.
//
//   pnpm exec tsx scripts/regression/conversations/run.ts --dry-run
//   pnpm exec tsx scripts/regression/conversations/run.ts --persona 01-has-targets --max-turns 3 --spend-cap 0.50
//   pnpm exec tsx scripts/regression/conversations/run.ts                 # all personas, defaults
//   pnpm exec tsx scripts/regression/conversations/run.ts --cleanup --run <runId>
//
// Needs both server keys: DEEPSEEK_API_KEY for Hank-under-test (the ephemeral
// users get canUseServerKey=true) and ANTHROPIC_API_KEY for the Opus 4.8
// persona simulator, whose client doesn't go through resolveLlmClient.
//
// Drives the real Hank pipeline in-process via runUserMessage against the
// shared (PROD) DB, with ephemeral tagged users that are torn down after each
// persona. A persona-raised halt stops the whole run. A spend cap aborts it.

import "dotenv/config";
import { setMaxListeners } from "events";
import { join } from "path";

import { HANK_MODEL } from "@/server/agent/hank/call";
import { prisma } from "@/server/db/prisma";

import { runPersona, type PersonaRunResult } from "./agent/personaAgent";
import { createPersonaSandbox } from "./isolation/setup";
import {
  teardownUser,
  residueForUser,
  cleanupRun,
  captureAdminNotes,
  captureScanOutcomes,
} from "./isolation/teardown";
import { SpendAccountant } from "./lib/spend";
import { makeRunId } from "./lib/tags";
import { PERSONAS } from "./personas";
import { runAssertions } from "./report/assertions";
import {
  writePersonaReport,
  writeIndex,
  type PersonaExtras,
} from "./report/reportWriter";
import { appendTurn } from "./report/transcript";
import { runMarkerRoundTrip } from "./verify/markerRoundTrip";

import type { Persona } from "./personas/types";
// qa-audit drives the real pipeline against EPHEMERAL tagged users that get
// torn down — those sub-agent runs must not be captured into SubAgentRun, or
// the sub-agent runtime audit would later audit throwaway-persona runs as real
// traffic. recordSubAgentRun honors this flag (src/server/agent/subAgentRun.ts).
process.env.HANK_DISABLE_SUBAGENT_CAPTURE = "1";

type Args = {
  dryRun: boolean;
  cleanup: boolean;
  runId: string | null;
  personaId: string | null;
  maxTurns: number;
  spendCap: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    cleanup: false,
    runId: null,
    personaId: null,
    maxTurns: 12,
    spendCap: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--cleanup") a.cleanup = true;
    else if (k === "--run") a.runId = argv[++i];
    else if (k === "--persona") a.personaId = argv[++i];
    else if (k === "--max-turns") a.maxTurns = Number(argv[++i]);
    else if (k === "--spend-cap") a.spendCap = Number(argv[++i]);
  }
  return a;
}

function dbHost(): string {
  const url = process.env.DATABASE_URL ?? "";
  const m = /@([^/:]+)/.exec(url);
  return m?.[1] ?? "(unknown host)";
}

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- dry run: zero spend, no DB writes ---
  if (args.dryRun) {
    const r = runMarkerRoundTrip();
    console.log(r.lines.join("\n"));
    console.log(`\nmarker round-trip: ${r.passed} passed, ${r.failed} failed`);
    await prisma.$disconnect();
    process.exit(r.failed === 0 ? 0 : 1);
  }

  // --- cleanup a prior run's orphans ---
  if (args.cleanup) {
    if (!args.runId) {
      console.error("--cleanup requires --run <runId>");
      await prisma.$disconnect();
      process.exit(1);
    }
    const log = await cleanupRun(args.runId);
    console.log(log.join("\n"));
    await prisma.$disconnect();
    process.exit(0);
  }

  // --- live run ---
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set — the persona agent (Opus 4.8) needs the server key.",
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  // The ephemeral users get canUseServerKey=true, so Hank-under-test falls back
  // to the server DEEPSEEK_API_KEY for them.
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY not set — Hank's calls will fail.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const runId = makeRunId();
  const artifactsDir = join(
    process.cwd(),
    "scripts/regression/conversations/artifacts",
    runId,
  );
  const personas: Persona[] = args.personaId
    ? PERSONAS.filter((p) => p.id === args.personaId)
    : PERSONAS;
  if (personas.length === 0) {
    console.error(
      `no persona matched id=${args.personaId}. Known: ${PERSONAS.map((p) => p.id).join(", ")}`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  const startedAtIso = nowIso();
  console.log(`\n=== QA audit run ${runId} ===`);
  console.log(`DB host: ${dbHost()}  (writes are torn down per persona)`);
  console.log(`Hank model: ${HANK_MODEL}   Persona: claude-opus-4-8`);
  console.log(`Personas: ${personas.map((p) => p.id).join(", ")}`);
  console.log(
    `Max turns/persona: ${args.maxTurns}   Spend cap: $${args.spendCap.toFixed(2)}\n`,
  );

  const spend = new SpendAccountant(prisma, args.spendCap);
  const createdUserIds: string[] = [];
  const entries: Array<{
    persona: Persona;
    result: PersonaRunResult;
    residueClean: boolean;
    extras: PersonaExtras;
  }> = [];
  let globalHalt: {
    personaId: string;
    turn: number;
    category?: string;
    evidence?: string;
  } | null = null;

  // One AbortController for the whole run; aborting cuts the current Hank turn
  // and the current persona Opus call. runUserMessage adds an abort listener
  // per turn, so over many turns the signal exceeds the default 10-listener
  // warning threshold — lift the cap (these are bounded by maxTurns).
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);

  for (const persona of personas) {
    if (spend.overCap()) {
      console.log(
        `\n[spend cap reached: $${spend.total().toFixed(2)} ≥ $${args.spendCap.toFixed(2)}] — stopping before ${persona.id}`,
      );
      break;
    }

    console.log(`\n--- ${persona.id} (${persona.displayName}) ---`);
    const sandbox = await createPersonaSandbox(runId, persona.id);
    createdUserIds.push(sandbox.userId);
    const transcriptPath = join(artifactsDir, `${persona.id}.jsonl`);

    let result: PersonaRunResult = {
      personaId: persona.id,
      userId: sandbox.userId,
      sessionId: sandbox.sessionId,
      endReason: "error",
      halted: null,
      turns: [],
      wrapup: null,
      error: "persona run did not complete",
    };
    try {
      result = await runPersona({
        persona,
        userId: sandbox.userId,
        sessionId: sandbox.sessionId,
        maxTurns: args.maxTurns,
        spend,
        signal: controller.signal,
        shouldAbort: () => spend.overCap(),
        onTurn: (rec) => {
          appendTurn(transcriptPath, rec);
          const flag = rec.harnessFlags.length
            ? ` ⚠️${rec.harnessFlags.length}`
            : "";
          const halt = rec.halt?.triggered ? " 🛑HALT" : "";
          console.log(
            `  turn ${rec.turn}: ${rec.goalProgress} | ${rec.actionResolved.slice(0, 70)}${flag}${halt}  ($${rec.costSoFarUsd.toFixed(2)})`,
          );
        },
      });
    } catch (err) {
      result = {
        personaId: persona.id,
        userId: sandbox.userId,
        sessionId: sandbox.sessionId,
        endReason: "error",
        halted: null,
        turns: [],
        wrapup: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    let extras: PersonaExtras = {
      adminNotes: [],
      assertions: [],
      scanOutcomes: [],
    };
    try {
      // Snapshot Hank cost + capture AdminNotes BEFORE teardown deletes them.
      await spend.syncHankCost(createdUserIds);
      const adminNotes = await captureAdminNotes(sandbox.userId);
      const scanOutcomes = await captureScanOutcomes(sandbox.userId);
      extras = {
        adminNotes,
        assertions: runAssertions(result.turns),
        scanOutcomes,
      };
      const teardownLog = await teardownUser(sandbox.userId);
      const residue = await residueForUser(sandbox.userId);
      const residueClean = Object.values(residue).every((n) => n === 0);
      if (!residueClean) {
        console.log(`  ⚠️ residue after teardown: ${JSON.stringify(residue)}`);
      }
      if (teardownLog.length)
        console.log(teardownLog.map((l) => `  ${l}`).join("\n"));
      entries.push({ persona, result, residueClean, extras });
    } finally {
      const failed = extras.assertions
        .filter((a) => !a.passed)
        .map((a) => a.name);
      const checkStr = failed.length ? `❌ ${failed.join(",")}` : "✅ checks";
      const flagStr = extras.adminNotes.length
        ? ` | ${extras.adminNotes.length} diligence flag(s)`
        : "";
      console.log(`  ${checkStr}${flagStr}`);
    }

    const reportPath = writePersonaReport(
      artifactsDir,
      persona,
      result,
      extras,
    );
    console.log(`  report: ${reportPath}  [${result.endReason}]`);

    if (result.endReason === "halt" && result.halted) {
      globalHalt = {
        personaId: persona.id,
        turn: result.halted.turn,
        category: result.halted.category,
        evidence: result.halted.evidence,
      };
      console.log(
        `\n🛑 HALT raised by ${persona.id} — stopping the experiment so it can be fixed.`,
      );
      break;
    }
  }

  const totals = {
    personaUsd: spend.personaTotal(),
    hankUsd: spend.hankTotal(),
    totalUsd: spend.total(),
  };
  const indexPath = writeIndex(
    artifactsDir,
    {
      runId,
      model: "claude-opus-4-8",
      maxTurns: args.maxTurns,
      spendCapUsd: args.spendCap,
      startedAtIso,
    },
    entries,
    totals,
    globalHalt,
  );

  console.log(`\n=== done ===`);
  console.log(
    `Spend: total $${totals.totalUsd.toFixed(2)} (persona $${totals.personaUsd.toFixed(2)} + Hank $${totals.hankUsd.toFixed(2)})`,
  );
  console.log(`Index: ${indexPath}`);
  if (globalHalt)
    console.log(
      `Halted at ${globalHalt.personaId} turn ${globalHalt.turn}: ${globalHalt.category}`,
    );

  await prisma.$disconnect();
  process.exit(globalHalt ? 2 : 0);
}

main().catch(async (err) => {
  console.error("fatal:", err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
