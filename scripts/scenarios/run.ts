// Walkthrough-pipeline scenarios runner.
//
// Each scenario lives in its own file under scripts/scenarios/cases/<name>.ts
// and exports a default Scenario. Adding a new scenario:
//   1. Drop a file in cases/ that `export default`s a Scenario object.
//   2. Add its filename (without .ts) to MANIFEST below in the run order
//      you want.
//
// Why the explicit manifest instead of fs-discovery: TypeScript imports are
// static and the manifest doubles as documentation ("here's what's covered"
// in one place + run order is intentional). New scenarios in cases/ without
// a manifest entry are intentionally not run; the safety prevents committing
// a scratch case file that mutates the DB.
//
// Each scenario:
//   1. Stages a clean DB-side starting state (focus + statuses).
//   2. Drives the pipeline by either calling the state machine directly OR
//      invoking the walkthrough runner with a synthetic user message OR
//      runUserMessage for cold-start coverage.
//   3. Asserts a set of structural facts about what happened (events, DB
//      side effects, persisted message shape). NEVER asserts exact agent
//      text — agent prose is freeform; we check tools/statuses/state.
//
// Run: pnpm tsx scripts/scenarios/run.ts             # cheap only (default)
//      pnpm tsx scripts/scenarios/run.ts --all       # cheap + expensive (real Anthropic drafts)
//      pnpm tsx scripts/scenarios/run.ts <name>      # one by name (ignores cost tag)
//      pnpm tsx scripts/scenarios/run.ts --list      # print the manifest + cost tags
//
// Pattern intent: keep this list growing as new "weird responses" surface.
// Don't write tight text matchers; assert on the same signals the user
// notices — "did a status appear?", "did the agent re-emit a duplicate
// terminal?", "did the right tool fire?".

import "dotenv/config";

// Cases imports — keep alphabetized within each section.
import agentTextReplyNoDuplicateTerminal from "./cases/agent-text-reply-no-duplicate-terminal";
import coldStartFreeTextReachesAgent from "./cases/cold-start-free-text-reaches-agent";
import defensiveGuardNarratesStaleJob from "./cases/defensive-guard-narrates-stale-job";
import dispatchCompanyBumpsReadyToActive from "./cases/dispatch-company-bumps-ready-to-active";
import freshJobArmNarrates from "./cases/fresh-job-arm-narrates";
import hankHandlesCrossModeCrud from "./cases/hank-handles-cross-mode-crud";
import idleJobArmIsSilent from "./cases/idle-job-arm-is-silent";
import jobPickerCaughtUpButtonWrapsCompany from "./cases/job-picker-caught-up-button-wraps-company";
import jobPickerEmptyFallsThroughToCaughtUp from "./cases/job-picker-empty-falls-through-to-caught-up";
import jobPickerFiresWithShortlistedAndDeferred from "./cases/job-picker-fires-with-shortlisted-and-deferred";
import jobPickerRevivesDeferredOnPick from "./cases/job-picker-revives-deferred-on-pick";
import narrationReadsForTheUser from "./cases/narration-reads-for-the-user";
import pickerBacklogContainsReadyAndNew from "./cases/picker-backlog-contains-ready-and-new";
import pickerEmptyCompanySubtitle from "./cases/picker-empty-company-subtitle";
import pickerImmediateContainsActive from "./cases/picker-immediate-contains-active";
import shortlistCommitAppliesStances from "./cases/shortlist-commit-applies-stances";
import walkthroughAgentRecognizesNamedSwitch from "./cases/walkthrough-agent-recognizes-named-switch";
import { ensureTestSession, withEventCleanup } from "./lib";

import type { Scenario } from "./lib";

// Run order. The first run-pipeline / state-machine scenarios go first so a
// catastrophic regression there fails fast before the expensive Anthropic-
// driven scenarios fire.
const SCENARIOS: Scenario[] = [
  idleJobArmIsSilent,
  freshJobArmNarrates,
  agentTextReplyNoDuplicateTerminal,
  pickerImmediateContainsActive,
  pickerBacklogContainsReadyAndNew,
  dispatchCompanyBumpsReadyToActive,
  shortlistCommitAppliesStances,
  narrationReadsForTheUser,
  defensiveGuardNarratesStaleJob,
  jobPickerFiresWithShortlistedAndDeferred,
  jobPickerRevivesDeferredOnPick,
  jobPickerCaughtUpButtonWrapsCompany,
  jobPickerEmptyFallsThroughToCaughtUp,
  pickerEmptyCompanySubtitle,
  coldStartFreeTextReachesAgent,
  walkthroughAgentRecognizesNamedSwitch,
  hankHandlesCrossModeCrud,
];

async function main() {
  const arg = process.argv[2];

  if (arg === "--list") {
    for (const s of SCENARIOS) {
      console.log(`  ${s.cost.padEnd(9)} ${s.name}`);
    }
    return;
  }

  await ensureTestSession();
  const all = arg === "--all";
  const filter = arg && !all ? arg : null;
  let targets: Scenario[];
  if (filter) {
    targets = SCENARIOS.filter((s) => s.name === filter);
    if (targets.length === 0) {
      console.error(`no scenario named '${filter}'`);
      console.error(
        `run 'pnpm tsx scripts/scenarios/run.ts --list' to see all`,
      );
      process.exit(2);
    }
  } else if (all) {
    targets = SCENARIOS;
  } else {
    targets = SCENARIOS.filter((s) => s.cost === "cheap");
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of targets) {
    console.log(`\n=== ${s.name}`);
    console.log(`   ${s.describe}`);
    try {
      const r = await withEventCleanup(() => s.run());
      for (const n of r.notes) console.log(`   ${n}`);
      if (r.skipped) {
        console.log(`   SKIP (${r.skipped})`);
        skipped++;
      } else if (r.ok) {
        console.log(`   PASS`);
        passed++;
      } else {
        console.log(`   FAIL`);
        failed++;
      }
    } catch (err) {
      console.error(`   THREW: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  const summaryParts = [`${passed} passed`, `${failed} failed`];
  if (skipped > 0) summaryParts.push(`${skipped} skipped`);
  console.log(`\n${summaryParts.join(", ")} (of ${targets.length}).`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
