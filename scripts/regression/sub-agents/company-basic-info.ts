// Audit harness for companyBasicInfoSubAgent.
//
// 5 fixture Companies of varying ATS-discoverability difficulty. Hunter does
// web_search + fetch_url + test_scrape; outputs sourceUrl + canonicalName +
// shortDescription, or cannot_scrape with a reason.
//
// Note: each case can do up to ~10 web_search calls (~$0.10/case in server-
// tool fees) plus Anthropic tokens. Budget ~$3-4 for the full 5-case run +
// 3-vote judge.

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { companyBasicInfoSubAgent } from "../../../src/server/subagents/registry/companyBasicInfo";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export const FIXTURES: Array<{
  companySlug: string;
  notes: string;
  // Not field-pinning outcome here: a "found" outcome with the wrong URL (the
  // Arbor collision bug) would pass the pin but is exactly the failure mode
  // we want to catch. The LLM judge validates the discovered sourceUrl
  // against the DB's known sourceUrl from contextMarkdown.
}> = [
  // Re-pointed 2026-06-16 to companies that exist in the prod DB with known
  // sourceUrls (old linear/modal/hebbia/dust/arbor set was local-only). Same
  // difficulty spread: well-known → generic-name disambiguation.
  {
    companySlug: "anthropic",
    notes: "well-known co with greenhouse URL — should rediscover quickly",
  },
  {
    companySlug: "glean",
    notes:
      "well-known infra co; greenhouse slug is 'gleanwork' (not 'glean') — probe_ats won't guess it, expect web_search escalation",
  },
  {
    companySlug: "perplexity-ai",
    notes: "well-known AI co, Ashby board — moderate",
  },
  {
    companySlug: "scale-ai",
    notes: "name 'Scale' is generic — disambiguation test",
  },
  {
    companySlug: "together-ai",
    notes: "name 'Together' is generic — hardest discovery case",
  },
  // HANK-382 / HANK-391 cases (added 2026-06-20) — these are the exact companies
  // the tickets named, and they exist in prod with known sourceUrls.
  {
    companySlug: "qdrant",
    notes:
      "HANK-382: Ashby DOMAIN-style slug 'qdrant.tech' — probe_ats should find it deterministically with NO web_search. Known URL: jobs.ashbyhq.com/qdrant.tech",
  },
  {
    companySlug: "sourcegraph",
    notes:
      "HANK-382: Greenhouse 'sourcegraph91' — the numeric suffix is unguessable; probe_ats should MISS and the hunter should escalate to web_search and still find it. Known URL: boards.greenhouse.io/sourcegraph91",
  },
  {
    companySlug: "runway",
    notes:
      "HANK-391: name 'Runway' collides — the AI-video company (jobs.ashbyhq.com/runway) vs runway.com (an FP&A SaaS). Correct = found jobs.ashbyhq.com/runway, OR outcome=ambiguous listing both. WRONG = found an FP&A/financial 'Runway' board.",
  },
  {
    companySlug: "liner",
    notes:
      "HANK-391: name 'Liner' maps to two distinct real companies; no sourceUrl on file. Correct = outcome=ambiguous (or a confidently-disambiguated found). WRONG = silently picking one without flagging the collision.",
  },
];

const SUB_AGENT_DESCRIPTION = `companyBasicInfoSubAgent takes a (companyId, companyName) and hunts a careers URL via probe_ats + web_search + fetch_url + test_scrape. Outputs one of:
- found: { sourceUrl, canonicalName, shortDescription, longNotes? } — sourceUrl must be test_scrape-verified to produce ≥2 jobs FOR THE RIGHT COMPANY
- ambiguous: { candidates: [{canonicalName, sourceUrl, shortDescription}] } — when the name maps to ≥2 DIFFERENT real companies (each with a working board) and nothing disambiguates which the user meant. This is a CORRECT, desirable outcome on a genuine collision — NOT a failure. The user picks from the candidates.
- cannot_scrape: { reason } — only after exhausting strategies

Strategy escalation:
1. probe_ats FIRST — deterministic, free: tries name- and domain-derived slug candidates across greenhouse/lever/ashby/teamtailor/gem in parallel. Catches the obvious slugs AND domain-style ones (Ashby's 'qdrant.tech'). Does NOT catch arbitrary numeric suffixes (Greenhouse 'sourcegraph91') — those need web_search.
2. web_search for ATS link or careers page (when probe_ats misses)
3. Fetch homepage and look for careers link
4. test_scrape on the company's careers page — resolves enterprise Workday / iCIMS boards

Should prefer canonical ATS URLs (jobs.lever.co/<slug>, boards.greenhouse.io/<slug>) over bespoke /careers redirects. canonicalName should come from web_search/ATS board header, NOT slug-derivation.

Two failure modes to watch: (a) premature cannot_scrape (keep trying), and (b) reporting found on a name COLLISION — a board that scrapes but belongs to a DIFFERENT company than the one named (the "Arbor" bug). On a true collision the correct move is outcome=ambiguous, not a guess.`;

const RUBRIC = `Evaluate the hunter's outcome and the search path it took.

**MUST (failure flags):**
- **URL correctness AND right-company**: If outcome=found, the sourceUrl must be a real, currently-working ATS URL that produces job postings **for the company that was named**. A board that scrapes but belongs to a DIFFERENT company sharing the name (e.g. an FP&A "Runway" when the AI-video Runway was meant) is a FAIL even though the board "works". Sanity-check against the currently-known sourceUrl in the context when shown.
- **Collision handling**: For a name that genuinely maps to two+ real companies, the RIGHT outcomes are either (a) found on the correct company (matching the known sourceUrl), or (b) ambiguous listing the real candidates. Silently picking the wrong company is the worst outcome; picking one of two without flagging when they're genuinely indistinguishable is a warn-to-fail.
- **ambiguous is valid, not a failure**: outcome=ambiguous on a genuine collision (≥2 distinct real companies, each with a working board) is CORRECT. Only fail it if the "candidates" are actually the same company twice, or if one obvious correct answer existed (e.g. the known sourceUrl) and the hunter punted anyway.
- **canonicalName accuracy**: Should match how the company brands itself, not a slug-derived guess.
- **No premature cannot_scrape**: cannot_scrape is appropriate ONLY after exhausting the strategies (probe_ats, web_search, homepage, test_scrape on the careers page). Flagging cannot_scrape on a discoverable company is a fail.
- **No fabrication**: sourceUrl(s) must be real URLs the sub-agent actually verified (probe_ats / test_scrape). Flag suspiciously made-up URL patterns.

**SHOULD (warn flags):**
- **Description quality**: shortDescription should be a one-line factual blurb with stage/sector/what-they-do. Generic ("AI company") is a warn.
- **Strategy efficiency**: The hunt shouldn't burn excessive turns. A 15+ turn hunt on a well-known co suggests the hunter struggled with ATS guessing.
- **canonicalName vs slug-derivation**: The sub-agent system prompt says "Don't slug-derive — use what web_search shows you". A canonicalName that's just the title-cased slug is a warn.
- **longNotes usefulness**: If present, longNotes should add color beyond shortDescription (funding history, product details, team context). Empty or generic longNotes on a known company is a warn.

When you write the rationale, anchor to the actual sourceUrl + canonicalName produced and whether they look right for this company.`;

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

  const companyArgIdx = process.argv.indexOf("--company");
  const onlyCompany =
    companyArgIdx !== -1 ? process.argv[companyArgIdx + 1] : undefined;
  const activeFixtures = onlyCompany
    ? FIXTURES.filter((f) => f.companySlug === onlyCompany)
    : FIXTURES;
  if (activeFixtures.length === 0)
    throw new Error(`no fixture matches --company ${onlyCompany}`);

  const auditEmail = process.env.AUDIT_USER_EMAIL;
  const user = auditEmail
    ? await prisma.user.findFirst({ where: { email: auditEmail } })
    : await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
      });
  if (!user) throw new Error("No admin user found");
  const userId = user.id;

  const session = await prisma.chatSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) throw new Error("no active ChatSession");

  const judgeApiKey = await resolveAnthropicApiKey(userId);
  const judgeClient = new Anthropic({ apiKey: judgeApiKey });

  const runId = `audit-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — companyBasicInfoSubAgent\n` +
      `Run ID: ${runId}\nFixtures: ${activeFixtures.length}\nUser: ${user.email}\n\n`,
  );

  for (const fx of activeFixtures) {
    const t0 = Date.now();
    process.stdout.write(`▶ ${fx.companySlug.padEnd(15)} ${fx.notes}\n`);
    try {
      const cr = await runOneCase({
        userId,
        sessionId: session.id,
        fixture: fx,
        judgeClient,
      });
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
}

async function runOneCase(args: {
  userId: string;
  sessionId: string;
  fixture: (typeof FIXTURES)[number];
  judgeClient: Anthropic;
}): Promise<CaseReport> {
  const company = await prisma.company.findUnique({
    where: { slug: args.fixture.companySlug },
    select: {
      id: true,
      name: true,
      slug: true,
      sourceUrl: true,
      description: true,
    },
  });
  if (!company)
    throw new Error(`no Company with slug=${args.fixture.companySlug}`);

  const contextMarkdown = [
    `### Company: ${company.name}`,
    `- slug: \`${company.slug}\``,
    `- Currently-known sourceUrl: ${company.sourceUrl ?? "_(none)_"}`,
    `- Currently-known description: ${company.description ?? "_(none)_"}`,
    "",
    `### Fixture notes`,
    args.fixture.notes,
    "",
    `_The hunter does NOT see the currently-known sourceUrl — it discovers from scratch. The judge sees it for sanity-check ("did the hunter rediscover the same URL?")._`,
  ].join("\n");

  const result = await runSubAgent(
    companyBasicInfoSubAgent,
    { companyName: company.name },
    args,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else if (result.output.outcome === "found") {
    outputMarkdown = [
      `**outcome:** \`found\``,
      "",
      `**sourceUrl:** ${result.output.sourceUrl}`,
      `**canonicalName:** ${result.output.canonicalName}`,
      `**shortDescription:** ${result.output.shortDescription}`,
      "",
      `**longNotes:**`,
      result.output.longNotes
        ? "> " + result.output.longNotes.split("\n").join("\n> ")
        : "_(none)_",
      "",
      `**turns:** ${result.turns}`,
    ].join("\n");
    outputSummary = `found: ${result.output.sourceUrl} (${result.turns} turns)`;
  } else if (result.output.outcome === "ambiguous") {
    const candidates = result.output.candidates;
    outputMarkdown = [
      `**outcome:** \`ambiguous\``,
      "",
      `**candidates:**`,
      ...candidates.map(
        (c) =>
          `> - ${c.canonicalName} — ${c.shortDescription} (${c.sourceUrl})`,
      ),
      "",
      `**turns:** ${result.turns}`,
    ].join("\n");
    outputSummary = `ambiguous: ${candidates.length} candidates (${result.turns} turns)`;
  } else {
    outputMarkdown = [
      `**outcome:** \`cannot_scrape\``,
      "",
      `**reason:** ${result.output.reason}`,
      "",
      `**turns:** ${result.turns}`,
    ].join("\n");
    outputSummary = `cannot_scrape (${result.turns} turns)`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "companyBasicInfoSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "companyBasicInfoSubAgent",
    caseName: company.name,
    caseKind: "real",
    caseDescription: args.fixture.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `known_url=${company.sourceUrl ? "yes" : "no"}`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
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
