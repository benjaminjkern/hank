// Audit harness for boardRecipeSubAgent.
//
// The sub-agent's job is to look at a board no wired provider recognizes and
// emit a RECIPE — a declarative read-plan — or an honest verdict about why it
// can't. It never emits job postings, so what's under test is the QUALITY OF A
// PLAN, not the accuracy of extracted data.
//
// ── The split, and why it isn't all judged ─────────────────────────────────
// Whether a recipe WORKS is a countable fact, so the harness settles it itself:
// it re-runs the emitted recipe through `runBoardRecipe` and counts postings,
// distinct titles, distinct on-domain URLs, body length. No LLM opinion is
// needed or wanted for that, and a judge asked to eyeball it would just be a
// slower, noisier version of running the thing.
//
// What the judge is for is the part with no ground truth: was this the right
// CALL? A `needs_browser` on a board that actually publishes an RSS feed is a
// real failure that no deterministic check catches, because the emission is
// structurally perfect. Same for a recipe that works but reads a "featured
// roles" carousel instead of the board, and for a note too vague to act on.
//
// Fixtures are live boards, deliberately: `test_recipe` is the sub-agent's own
// verification loop, and doubling it would mean predicting every recipe the
// model might write. Consequence — a red case is as often "this company stopped
// hiring" as a regression. Check the URL by hand before believing it.
//
// Cost: `deepseek-v4-pro`, up to 8 turns, each `test_recipe` turn doing real
// fetches, plus a 3-vote Opus judge per case. Budget ~$2-3 for the 5-case run.
//
// Run: pnpm tsx scripts/regression/sub-agents/board-recipe.ts --live
// (--live required because DATABASE_URL points at the prod DB; the run is
// read-only — the sub-agent writes nothing and the harness never persists.)

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { loadBoardRecipeInput } from "../../../src/server/procedures/registry/reconBoard/loadBoardRecipeInput";
import { probeGenericBoard } from "../../../src/server/scrape/generic/genericProbe";
import { runBoardRecipe } from "../../../src/server/scrape/recipe/runRecipe";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { boardRecipeSubAgent } from "../../../src/server/subagents/registry/boardRecipe";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

import type { SubAgentResult } from "../../../src/server/subagents/lib/types";
import type { BoardRecipeOutput } from "../../../src/server/subagents/registry/boardRecipe";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Every fixture is a board the DETERMINISTIC probe cannot read — that's the
// only population recon ever sees, so grading it on anything else would grade a
// call production never makes. The harness asserts that up front and skips a
// board the probe has since learned to read (which is good news, not a failure:
// it means the free tier widened).
export const FIXTURES: Array<{
  name: string;
  url: string;
  notes: string;
  // What a correct run looks like. `recipe` means a working plan is reachable
  // from the static page; `needs_browser` means it genuinely isn't and the
  // honest answer is to say so.
  expect: "recipe" | "needs_browser";
}> = [
  {
    name: "trivago",
    url: "https://jobs.trivago.com/",
    expect: "needs_browser",
    notes:
      "SPA that fetches its board after render, and the probe finds no static list, no feed and no postings sitemap. The graded question is whether the model says so instead of inventing a plausible-looking recipe — a confident wrong recipe here is worse than an honest miss, because it would look like it works.",
  },
  {
    name: "ibm",
    url: "https://careers.ibm.com/",
    expect: "needs_browser",
    notes:
      "The sitemap exists but holds category pages, not postings. Tests whether the model checks that a sitemap actually contains JOB DETAIL urls before building a recipe on it — the pathContains trap.",
  },
  {
    name: "arc.dev",
    url: "https://arc.dev/remote-jobs",
    expect: "needs_browser",
    notes:
      "Aggregator SPA with blobs present but no board array in them. Tests whether the model can tell a hydration payload that HAS data from one that has the RIGHT data.",
  },
  {
    name: "tesla",
    url: "https://www.tesla.com/careers/search/",
    expect: "needs_browser",
    notes:
      "The plain page fetch is bot-blocked, so the evidence bundle arrives nearly empty. Tests the degenerate-input case: with almost nothing to go on, does it report honestly rather than guessing from the URL shape?",
  },
  // A positive case matters as much as the negatives — a sub-agent that learns
  // to answer "needs_browser" to everything would pass a suite of misses.
  // Swap this row if the board changes shape; what it must remain is a board
  // the probe cannot read but a careful reader can.
  {
    name: "wellfound",
    url: "https://wellfound.com/jobs",
    expect: "recipe",
    notes:
      "POSITIVE CONTROL. Must not be answered with needs_browser. If this board becomes probe-readable or genuinely browser-only, replace the row rather than deleting it — without a positive case the suite rewards giving up.",
  },
];

const SUB_AGENT_DESCRIPTION = `boardRecipeSubAgent is handed a structural digest of a job board's page — NOT its HTML — and works out how to read it. The digest contains: what the deterministic probe already tried and failed at, an OUTLINE of every JSON blob embedded in the page (key names, types, sample values, array lengths), API-ish URLs found in inline scripts, a repeated-DOM skeleton, and a sitemap summary.

It outputs one of:
- recipe: a declarative BoardRecipe — { list: {kind: json|embedded|feed|html|sitemap, url, ...}, itemsPath, fields: {title, sourceUrl, rawContent?, location?, ...}, detail?, paging? } — that it has VERIFIED by calling the test_recipe read tool, which runs the plan against the live board and reports what came back.
- needs_browser: the postings demonstrably only exist after client-side render.
- needs_auth: a login or anti-bot wall.
- exhausted: everything available was tried and nothing read the board.

It has two read tools: test_recipe (run a candidate recipe for real) and fetch_url (look at one posting page, or confirm a URL template resolves).

CRITICAL to how this is judged: the sub-agent NEVER emits job postings. A recipe is data, executed later by a deterministic runner. So "did it extract the jobs correctly" is not the question — "is this the right plan, and was reporting it the right call" is.

The population it sees is boards the free deterministic probe already failed on. An honest needs_browser is a good outcome on a genuinely client-rendered board; the expensive failure is a confident recipe that looks right and isn't.`;

const RUBRIC = `You are judging a PLAN, not extracted data. The harness has already run the emitted recipe itself and reported the result in the output section — trust those numbers, don't re-derive them.

**MUST (failure flags):**
- **The outcome is the right call.** The context states what a correct run looks like for this board and why. Reporting needs_browser on a board that a careful reader could have read from the evidence shown is a FAIL — check the blob outlines, script URLs and sitemap summary in the context and say whether an answer was actually sitting there.
- **No unverified recipe.** The sub-agent must run a candidate through test_recipe before reporting it. If the harness's own re-run says the recipe returns nothing, that means it reported a plan it hadn't verified — FAIL.
- **The recipe reads the BOARD, not a fragment of it.** A plan that works but returns 6 postings off a "featured roles" carousel when the board has hundreds is a fail dressed as a pass. Compare the posting count against what the notes say about the board's size, and look at the sample titles for signs it matched a promo strip or a category list.
- **sourceUrl integrity.** The URLs must identify postings: distinct, on the board's domain, no page/offset/session parameters. This is the field that becomes a permanent database key, so a template built on a guess the model never checked is a fail even if it happens to work today.
- **No invented postings.** The output must contain a plan, never job listings. Any attempt to transcribe or list postings is a hard fail — it's the one thing this design exists to make impossible.

**SHOULD (warn flags):**
- **The note is actionable.** An engineer reads it to decide whether to hand-write a scraper for this board software. "Couldn't read it" is a warn; "the list is fetched by POST /api/search with a body signed client-side" is what's wanted.
- **Field coverage.** A recipe that maps only title + url, when the evidence clearly showed location / department / body keys, leaves the downstream matching passes blind. Warn.
- **Efficiency.** The evidence is front-loaded, so a healthy run commits in 2-3 turns. Burning 8 turns suggests it was guessing rather than reading the outlines.
- **familyKey.** A recognizable board software should be named ("wp-job-manager", "recruitee"), since that's what groups boards into "worth a real provider file".

Anchor the rationale to the specific locator it chose (which array, which keys) and whether the evidence supported it.`;

async function main() {
  const allowLive = process.argv.includes("--live");
  const dbHost =
    (process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "(unknown)";
  if (!isLocalHost(dbHost) && !allowLive) {
    throw new Error(
      `DATABASE_URL points at non-local host "${dbHost}". Re-run with --live to allow.`,
    );
  }
  process.stdout.write(`DB: ${dbHost}\n`);

  const boardArgIdx = process.argv.indexOf("--board");
  const onlyBoard =
    boardArgIdx !== -1 ? process.argv[boardArgIdx + 1] : undefined;
  const activeFixtures = onlyBoard
    ? FIXTURES.filter((f) => f.name === onlyBoard)
    : FIXTURES;
  if (activeFixtures.length === 0)
    throw new Error(`no fixture matches --board ${onlyBoard}`);

  const auditEmail = process.env.AUDIT_USER_EMAIL;
  const user = auditEmail
    ? await prisma.user.findFirst({ where: { email: auditEmail } })
    : await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
      });
  if (!user) throw new Error("No admin user found");

  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) throw new Error("no active ChatSession");

  const judgeClient = new Anthropic({
    apiKey: await resolveAnthropicApiKey(user.id),
  });

  const runId = `audit-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — boardRecipeSubAgent\n` +
      `Run ID: ${runId}\nFixtures: ${activeFixtures.length}\nUser: ${user.email}\n\n`,
  );

  for (const fx of activeFixtures) {
    const t0 = Date.now();
    process.stdout.write(`▶ ${fx.name.padEnd(12)} ${fx.url}\n`);
    try {
      const cr = await runOneCase({
        userId: user.id,
        sessionId: session.id,
        fixture: fx,
        judgeClient,
      });
      if (!cr) {
        process.stdout.write(
          `   ⏭  SKIPPED — the deterministic probe now reads this board, so recon would never see it. Swap the fixture.\n\n`,
        );
        continue;
      }
      cr.durationMs = Date.now() - t0;
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

  const totalJudge = cases.reduce((s, c) => s + c.judgeUsdCost, 0);
  process.stdout.write(
    `\nReport: ${reportPath}\nTotal judge cost: $${totalJudge.toFixed(3)}\n`,
  );
  await prisma.$disconnect();
}

// Returns null when the fixture no longer belongs to recon's population.
async function runOneCase(args: {
  userId: string;
  sessionId: string;
  fixture: (typeof FIXTURES)[number];
  judgeClient: Anthropic;
}): Promise<CaseReport | null> {
  const { fixture } = args;

  // The probe runs first for two reasons: it's the precondition (recon only
  // ever sees boards it failed on), and its `tried` list is a real input to the
  // prompt — production passes it so recon doesn't re-propose a dead technique.
  const probe = await probeGenericBoard(fixture.url);
  if (probe.ok) return null;

  // Call the production loader rather than hand-building evidence: a harness
  // that pre-renders what prod renders differently grades a prompt production
  // never sends.
  const input = await loadBoardRecipeInput({
    companyName: fixture.name,
    sourceUrl: fixture.url,
    probeTried: probe.tried,
  });

  const result = await runSubAgent(boardRecipeSubAgent, input, args);

  const contextMarkdown = [
    `### Board: ${fixture.name}`,
    `- url: ${fixture.url}`,
    `- expected outcome: \`${fixture.expect}\``,
    "",
    `### Why this board is here`,
    fixture.notes,
    "",
    `### What the deterministic probe tried (and failed at)`,
    probe.tried.map((t) => `- ${t}`).join("\n"),
    "",
    `### The evidence the sub-agent was given`,
    `_This is the whole input — it never sees the page's HTML._`,
    "",
    `**page fetched:** ${input.evidence.fetched ? "yes" : "NO (usually bot protection)"}`,
    "",
    "#### JSON blob outlines",
    "```",
    input.evidence.blobOutlines.slice(0, 4000),
    "```",
    "#### API-ish URLs in inline scripts",
    "```",
    input.evidence.scriptUrls.slice(0, 1200),
    "```",
    "#### Repeated DOM structure",
    "```",
    input.evidence.domSkeleton.slice(0, 2000),
    "```",
    "#### Sitemap",
    "```",
    input.evidence.sitemapSummary,
    "```",
  ].join("\n");

  const { outputMarkdown, outputSummary, actualFields } = await describeResult(
    result,
    fixture.url,
  );

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "boardRecipeSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
    expectedFields: { outcome: { equals: fixture.expect, label: "outcome" } },
    actualFields,
  });

  return {
    subAgent: "boardRecipeSubAgent",
    caseName: fixture.name,
    caseKind: "real",
    caseDescription: fixture.notes,
    source: "live",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `probe missed after: ${probe.tried.length} techniques`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

// The deterministic half. Everything countable about a recipe is settled here,
// so the judge is left with the questions that genuinely need judgement.
async function describeResult(
  result: SubAgentResult<BoardRecipeOutput>,
  boardUrl: string,
): Promise<{
  outputMarkdown: string;
  outputSummary: string;
  actualFields: Record<string, unknown>;
}> {
  if (!result.ok) {
    return {
      outputMarkdown: `**ERROR:** ${result.error}`,
      outputSummary: `ERROR: ${result.error.slice(0, 120)}`,
      actualFields: { outcome: "error" },
    };
  }
  const output = result.output;
  if (output.outcome !== "recipe") {
    return {
      outputMarkdown: [
        `**outcome:** \`${output.outcome}\``,
        "",
        `**note:** ${output.note}`,
        "",
        `**turns:** ${result.turns}`,
      ].join("\n"),
      outputSummary: `${output.outcome} (${result.turns} turns)`,
      actualFields: { outcome: output.outcome },
    };
  }

  // Re-run the emitted recipe ourselves. The sub-agent's own claim about what
  // test_recipe returned is not evidence — this is.
  const verified = await runBoardRecipe(output.recipe, { boardUrl });
  const check = verified.ok
    ? checkPostings(verified.data.jobs, boardUrl)
    : { line: `**DOES NOT RUN:** ${verified.error}`, jobs: 0 };

  return {
    outputMarkdown: [
      `**outcome:** \`recipe\` (sub-agent reported ${output.jobCount} postings)`,
      "",
      `**note:** ${output.note}`,
      "",
      `### Harness re-run of the emitted recipe`,
      check.line,
      "",
      `### The recipe`,
      "```json",
      JSON.stringify(output.recipe, null, 2),
      "```",
      "",
      `**turns:** ${result.turns}`,
    ].join("\n"),
    outputSummary: `recipe — ${check.jobs} postings on re-run (${result.turns} turns)`,
    actualFields: { outcome: "recipe" },
  };
}

function checkPostings(
  jobs: Array<{ title: string; sourceUrl: string; rawContent: string }>,
  boardUrl: string,
): { line: string; jobs: number } {
  const distinctTitles = new Set(jobs.map((j) => j.title.toLowerCase())).size;
  const distinctUrls = new Set(jobs.map((j) => j.sourceUrl)).size;
  const host = safeHost(boardUrl);
  const offDomain = jobs.filter((j) => {
    const h = safeHost(j.sourceUrl);
    return h != null && host != null && !h.endsWith(registrable(host));
  }).length;
  const medianBody = median(jobs.map((j) => j.rawContent.length));
  const samples = jobs
    .slice(0, 5)
    .map((j) => `  - "${j.title}" → ${j.sourceUrl}`)
    .join("\n");
  return {
    jobs: jobs.length,
    line: [
      `**RUNS:** ${jobs.length} postings · ${distinctTitles} distinct titles · ${distinctUrls} distinct URLs · ${offDomain} off-domain URLs · median body ${medianBody} chars`,
      "",
      samples,
    ].join("\n"),
  };
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const sorted = [...ns].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function registrable(host: string): string {
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const { readFile } = await import("fs/promises");
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function isLocalHost(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function glyph(v: string): string {
  return v === "pass" ? "✓" : v === "fail" ? "✗" : "⚠";
}

if (isEntrypoint(import.meta.url))
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
