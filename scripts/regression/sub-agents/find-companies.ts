// Audit harness for findCompaniesSubAgent (the merged grow-the-watchlist sub-agent —
// replaces discovery-search + suggest-companies).
//
// Each fixture injects its OWN candidate context (thesis / patterns / resume /
// watchlist-with-status) as the sub-agent's plain input, so the direction-match +
// no-watchlist-duplicate + set-aside-signal grading is coherent with the
// injected candidate rather than the host admin's live thesis. web_search still
// hits the real web when the sub-agent chooses to use it — the companies it
// surfaces ARE real, which is the point; only the thesis/watchlist it reasons
// against are injected.
//
// Coverage:
//   - direction-match + real companies + dedup (an injected watchlist to avoid)
//   - dedup under pressure (a watchlist pre-loaded with the obvious names)
//   - direction hard-constraint (a stage band: Series A/B, don't pad with Series D)
//   - a different domain corner (payments/fintech) to catch thesis-coupling
//   - set-aside signal: closed companies (with reasons) should steer suggestions
//     AWAY from that shape
//
// Run: pnpm tsx scripts/regression/sub-agents/find-companies.ts --live
// (web_search-backed — this is the slowest + priciest audit.)

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  PrismaClient,
  CompanyStatus,
} from "../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import {
  findCompaniesSubAgent,
  type WatchlistContextEntry,
} from "../../../src/server/subagents/registry/findCompanies";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

// The two former profile notes (a "search thesis" + an "about me") are one
// profile.md now. Fixtures still author the halves separately — they're
// different kinds of content and it keeps each case readable — and this stitches
// them into the single sectioned note the sub-agent actually receives.
function mergeProfile(thesis: string, patterns: string): string {
  return `## Search thesis\n${thesis}\n\n## Constraints, voice & patterns\n${patterns}`;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const RESUME_INFRA = `## Roles

### Staff Platform Engineer — Acme (2022–present)
- Owned the service mesh and the internal developer platform.
- Built the CI/CD pipeline every backend team ships through.
- ~9 years across infrastructure and distributed systems.

## Skills
Go, Kubernetes, Terraform, distributed systems, platform`;

const RESUME_PAYMENTS = `## Roles

### Senior Backend Engineer, Payments — Cleo (2019–present)
- Built the ledger and money-movement services.
- Built fraud-scoring for the risk pipeline.
- 8 years across payments and risk.

## Skills
payments, ledgers, risk, Go, Java, Postgres, Kafka`;

const RESUME_DATA = `## Roles

### Staff Data Platform Engineer — Northwind (2020–present)
- Owned the batch + streaming data platform: ingestion, orchestration, the feature store.
- Built the self-serve warehouse layer every product team queries.
- ~10 years across data engineering and ML infrastructure.

## Skills
Python, Spark, Airflow, dbt, Kafka, feature stores, ML infrastructure`;

const RESUME_DEVTOOLS = `## Roles

### Staff Engineer, Developer Experience — Bolt Tooling (2021–present)
- Owned the frontend build system and the client SDKs every app team integrates.
- Built the CLI and local dev server used across the org.
- ~9 years across developer tools and frontend infrastructure.

## Skills
TypeScript, Node.js, Rust, bundlers, compilers, SDK design, browser tooling`;

// Terse helpers to build the injected watchlist with the status/reason signal.
const pursuing = (name: string): WatchlistContextEntry => ({
  name,
  status: CompanyStatus.APPLYING,
});
const watching = (name: string): WatchlistContextEntry => ({
  name,
  status: CompanyStatus.NEW,
});
const closed = (name: string, reason: string): WatchlistContextEntry => ({
  name,
  status: CompanyStatus.CLOSED,
  reason,
});

type Fixture = {
  name: string;
  direction: string;
  count?: number;
  notes: string;
  profile: string;
  resume: string;
  watchlist: WatchlistContextEntry[];
  expect: string;
};

export const FIXTURES: Fixture[] = [
  {
    name: "data-platform-startups-with-dedup",
    direction:
      "data / ML-platform startups, Series A-B, that hire remote-first",
    count: 10,
    notes: "specific direction + a small watchlist to dedup against",
    profile: mergeProfile(
      "Staff data-platform engineer targeting data-infrastructure and ML-platform startups, Series A through B. Pipelines, orchestration, feature stores, the warehouse layer. Remote-first.",
      "Warm but concise. $200k floor. Remote-first. Wants a real data-platform team, not a single dashboard product.",
    ),
    resume: RESUME_DATA,
    watchlist: [pursuing("dbt Labs"), pursuing("Airbyte"), watching("Tecton")],
    expect:
      "5–15 real, currently-operating Series A-B data / ML-platform / data-infrastructure startups that plausibly hire remote-first. NONE of the 3 watchlist names (dbt Labs, Airbyte, Tecton) re-suggested. oneLineReason cites sector/stage specifically. `analysis` accounts for the search.",
  },
  {
    name: "dedup-under-pressure",
    direction:
      "AI-infrastructure and model-serving companies hiring backend engineers",
    count: 10,
    notes:
      "the obvious names are ALL pre-loaded on the watchlist — must surface less-obvious ones.",
    profile: mergeProfile(
      "Staff backend engineer targeting AI-infrastructure and model-serving companies. Distributed systems, inference platforms, GPU scheduling. SF Bay Area or remote.",
      "Plainspoken and technical. SF Bay Area or remote. $265k floor.",
    ),
    resume: RESUME_INFRA,
    watchlist: [
      "Anthropic",
      "OpenAI",
      "Databricks",
      "Modal Labs",
      "Together AI",
      "Pinecone",
      "Weights & Biases",
      "Mistral AI",
      "Anyscale",
      "Cohere",
      "Hugging Face",
      "LangChain",
    ].map(watching),
    expect:
      "Real AI-infrastructure / model-serving companies that are NOT on the 12-name watchlist — the obvious names are all taken, so the value is surfacing less-obvious-but-real ones. ZERO watchlist duplicates is the key MUST. Direction-matched; 5–15; `analysis` can acknowledge the obvious ones were already covered.",
  },
  {
    name: "em-stage-band-constraint",
    direction: "engineering manager roles at Series A/B AI startups",
    count: 8,
    notes:
      "role-shape + a hard stage band; must return companies sized to hire EMs and honor Series A/B (no Series D unicorns padding the list).",
    profile: mergeProfile(
      "Senior engineer ready to move into an Engineering Manager role at a Series A/B AI startup with a real eng org (~15+ engineers). Boston or remote.",
      "Making the move to management now. Wants a team big enough to need an EM. Boston or remote. $245k floor.",
    ),
    resume: RESUME_INFRA,
    watchlist: [],
    expect:
      "Real Series A/B AI startups with eng teams large enough to need EMs (~15+ engineers). HONOR the stage band — don't pad with Series D/late-stage unicorns; returning fewer on-band companies beats diluting. `analysis` should acknowledge the role→company translation (returning companies sized to hire EMs). Any off-band exception must be flagged in its reason.",
  },
  {
    name: "payments-domain",
    direction:
      "payments and fintech infrastructure companies hiring senior backend engineers",
    count: 10,
    notes:
      "different domain corner (catches thesis-coupling); small watchlist to dedup.",
    profile: mergeProfile(
      "Senior backend engineer targeting payments/risk and fintech infrastructure. Ledgers, money-movement, fraud. Austin or remote.",
      "Understated, detail-driven. Payments/fintech focus. Austin or remote. $180k floor.",
    ),
    resume: RESUME_PAYMENTS,
    watchlist: [pursuing("Stripe"), watching("Adyen")],
    expect:
      "Real payments / fintech-infrastructure companies (not consumer-fintech apps) that hire senior backend engineers. NOT Stripe or Adyen (on watchlist). Direction-matched to payments infra; 5–15; specific reasons.",
  },
  {
    name: "devtools-set-aside-signal",
    direction:
      "developer-tools and frontend-infrastructure companies hiring senior engineers",
    count: 10,
    notes:
      "several companies were CLOSED for being too early-stage — suggestions should steer AWAY from pre-seed / tiny-team shops toward more established ones.",
    profile: mergeProfile(
      "Staff developer-experience engineer targeting developer-tools and frontend-infrastructure companies with a shipped product and real adoption. Build systems, SDKs, framework tooling. Remote-first.",
      "Measured, product-minded. Remote-first. $300k floor. Prefers a company past the pre-product stage — a real user base over a four-person prototype.",
    ),
    resume: RESUME_DEVTOOLS,
    watchlist: [
      pursuing("Vercel"),
      closed(
        "Some Seed Startup",
        "passed on (too early): 4-person pre-seed team",
      ),
      closed(
        "Another Tiny Co",
        "passed on (too early): pre-product, no revenue",
      ),
    ],
    expect:
      "Real developer-tools / frontend-infrastructure companies past the seed stage (Series B+ / scale-ups) — the two CLOSED 'too early' companies are a signal to AVOID pre-seed/tiny-team shops. Not Vercel (on watchlist). Reasons should lean toward companies with an established eng org and a shipped product. 5–15.",
  },
];

const SUB_AGENT_DESCRIPTION = `findCompaniesSubAgent is the merged grow-the-watchlist sub-agent. Given a direction (free-form query) + the user's thesis, resume, and existing watchlist (with per-company status + why-set-aside), it emits candidate companies for the user to approve. Output: { analysis, candidates: [{name, oneLineReason, url?}] }, where \`analysis\` is the private scratchpad it fills BEFORE the list — the account of what it searched vs. worked from knowledge, and which claim traces to which result. It has web_search available and DECIDES whether to use it (a well-understood thesis can be answered from knowledge; a fresh/narrow direction wants a search). In this audit the candidate context (thesis / patterns / resume / watchlist) is INJECTED, so the model deduped against the injected watchlist and matched against the injected thesis — but any companies it surfaces from a search come from real live web_search.

The search should:
- Return 5-15 candidates (sweet spot) — not 1-2 (under-curated) or 30+ (overwhelming).
- Each candidate a recognizable, real, currently-operating company.
- oneLineReason grounded in the injected thesis (sector/stage/what they do).
- AVOID any company already on the injected watchlist (any status).
- Use the watchlist as SIGNAL: lean toward the shape of "actively pursuing" companies, away from the shape of "set aside for a fit reason" ones.
- Honor the direction's hard constraints (stage band, remote-first) rather than padding to a count.
- An \`analysis\` that gives real provenance for the list: searched vs. worked-from-knowledge, and which candidates/claims trace to a result it actually read. A list whose analysis can't account for a name is the fabrication signal.`;

const RUBRIC = `Evaluate the candidate list against the direction and the INJECTED candidate context shown below. The auditor's intended outcome is included as "Expected".

**MUST (failure flags):**
- **Real companies**: every candidate must be a recognizable, currently-operating company. Fabricated/defunct names are fails.
- **Direction match**: candidates must match the direction (sector + any stage/remote constraint). "infra AI startups" returning consumer-product companies is a fail.
- **No watchlist duplicates**: re-recommending a company on the injected watchlist (ANY status) is a fail (case-insensitive).
- **Reasoning grounded**: oneLineReason must actually describe the company (sector, stage, what they do), not just restate the direction. Never invent a funding round/dollar figure.

**SHOULD (warn flags):**
- **Set-aside signal**: when the watchlist has companies CLOSED for a fit reason (e.g. "too early"), suggestions that ignore that steer (e.g. surfacing pre-seed shops after the user closed two for being too early) are a warn.
- **Count calibration**: 5-15 sweet spot; <3 under-curated, >20 overwhelming (warn unless notes explain).
- **Hard-constraint respect**: when the direction names a stage band ("Series A/B") or hard filter ("remote-first"), off-band companies dilute the list — a warn (a single flagged exception is fine). Honoring it with fewer companies is correct, not a warn.
- **Diversity**: all-one-niche when the direction is broader is a warn.
- **Useful notes**: notes should explain what was searched/filtered (or that it worked from knowledge); for a role-shaped direction, acknowledge the role→company translation.
- **Specificity**: cite stage/sector/product specifically.

Evaluate the LIST as a whole + 2-3 candidates as exemplars. Note: since web_search is live, the exact company set varies run-to-run — judge the QUALITY of the curation, not which specific companies appeared.`;

function nowMs(): number {
  return Date.now();
}

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

  const auditEmail =
    process.env.AUDIT_USER_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
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

  const judgeClient = new Anthropic({
    apiKey: await resolveAnthropicApiKey(userId),
  });

  const runId = `audit-${nowMs().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — findCompaniesSubAgent\nRun ID: ${runId}\nFixtures: ${FIXTURES.length}\nUser: ${user.email}\n\n`,
  );

  for (const fx of FIXTURES) {
    const t0 = nowMs();
    process.stdout.write(`▶ ${fx.name} — "${fx.direction.slice(0, 52)}"\n`);
    try {
      const cr = await runOneCase({
        userId,
        sessionId: session.id,
        fx,
        judgeClient,
      });
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
  fx: Fixture;
  judgeClient: Anthropic;
}): Promise<CaseReport> {
  const { fx } = args;
  const watchlistNames = fx.watchlist.map((w) => w.name);
  const watchlistSet = new Set(watchlistNames.map((n) => n.toLowerCase()));

  const rosterLines = fx.watchlist
    .map((w) => `- ${w.name} [${w.status}]${w.reason ? ` — ${w.reason}` : ""}`)
    .join("\n");

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    "",
    `**Auditor's expected outcome:** ${fx.expect}`,
    "",
    `### Direction`,
    `> ${fx.direction}`,
    `(target count: ${fx.count ?? "unspecified"})`,
    "",
    `### Injected profile (profile.md)`,
    "```md\n" + fx.profile + "\n```",
    "",
    `### Injected resume summary`,
    "```json\n" + fx.resume.slice(0, 1500) + "\n```",
    "",
    `### Injected watchlist (${fx.watchlist.length} — must NOT be re-suggested; status/reason is signal)`,
    rosterLines || "_(empty)_",
  ].join("\n");

  const result = await runSubAgent(
    findCompaniesSubAgent,
    {
      profile: fx.profile,
      resume: fx.resume,
      watchlist: fx.watchlist,
      direction: fx.direction,
      count: fx.count,
    },
    args,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    const duplicates = result.output.candidates.filter((c) =>
      watchlistSet.has(c.name.toLowerCase()),
    );
    outputMarkdown = [
      `**analysis (private scratchpad, written BEFORE the list):**`,
      result.output.analysis ?? "_(none)_",
      "",
      `**Candidates (${result.output.candidates.length}):**`,
      "",
      ...result.output.candidates.map((c) => {
        const dup = watchlistSet.has(c.name.toLowerCase())
          ? " ⚠ ALREADY ON WATCHLIST"
          : "";
        return `- **${c.name}**${dup} — ${c.oneLineReason}`;
      }),
      "",
      duplicates.length > 0
        ? `_Mechanical check: ${duplicates.length} candidate(s) already on watchlist (a MUST violation)_`
        : `_Mechanical check: no watchlist duplicates ✓_`,
    ].join("\n");
    outputSummary = `${result.output.candidates.length} candidates, ${duplicates.length} watchlist dups`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "findCompaniesSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "findCompaniesSubAgent",
    caseName: fx.name,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `count_target=${fx.count ?? "?"}, watchlist=${fx.watchlist.length}`,
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
