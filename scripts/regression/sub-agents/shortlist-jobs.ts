// Audit harness for shortlistJobsSubAgent (the RELATIVE shortlist ranker).
//
// Each fixture is FULLY SELF-CONTAINED: a SYNTHETIC company + SYNTHETIC detail
// pool (each job carries its scan verdict) + a synthetic candidate context
// (thesis / resume). Since the sub-agent takes its whole context as an argument,
// a fixture is just a hand-written ShortlistJobsInput — nothing is injected past
// a DB read, because there are no DB reads. The run is hermetic by construction:
// the sub-agent is a transform (no read tools, one turn), so there is nothing it
// could reach for beyond what the fixture states.
//
// Coverage of the rubric's MUSTs:
//   - rank & select (mixed scan verdicts → 3-5 shortlist, frontend→borderline,
//     near-dup → pre-check one): no-padding / no-starvation.
//   - prior-pass discipline: a role the user passed over last round is a
//     DOWNGRADE (borderline), never a pass — a set-aside isn't "would never
//     apply".
//   - title fidelity / no fabrication: a billing role for a search/platform resume
//     must NOT be shortlisted on invented billing experience.
//   - seniority/track discipline: Director/EM not shortlisted for a senior-IC
//     candidate who said "not management".
//
// Run: pnpm tsx scripts/regression/sub-agents/shortlist-jobs.ts --live

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { capShortlistPicks } from "../../../src/server/procedures/registry/shortlist/seedBoardStances";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import {
  shortlistJobsSubAgent,
  type ShortlistCandidate,
} from "../../../src/server/subagents/registry/shortlistJobs";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// --- Synthetic detail-candidate pool builder --------------------------------

type DetailJob = ShortlistCandidate;
function dj(
  id: string,
  title: string,
  location: string,
  matchBucket: "STRONG" | "POSSIBLE" | "WEAK",
  matchReason: string,
  summary: string,
  compensation: string | null = null,
): DetailJob {
  return {
    id,
    title,
    enrichedSummary: summary,
    rawContent: null,
    location,
    compensation,
    department: "Engineering",
    employmentType: "Full-time",
    attributes: null,
    enrichedAttributes: null,
    matchBucket,
    matchScore: null,
    matchReason,
  };
}

// --- Persona ----------------------------------------------------------------

// The user's background exactly as prod stores it: the resume.md memory note,
// full detail, markdown. Deliberately carries NO payments work — that absence is
// the only signal `no-fabricated-fit` has to work with.
const RESUME_PLATFORM = `## Roles

### Staff Platform Engineer — Acme (2021–present)
- Built the search/ranking platform serving product discovery across the catalog.
- Owned the query layer end to end: index design, relevance tuning, latency budgets.
- Built internal deploy tooling used by every backend team.

### Senior Backend Engineer — Meridian (2018–2021)
- Distributed services in Go on Kubernetes; owned the API gateway and its rate limiting.
- Migrated the primary datastore to Postgres with no downtime.

## Skills
Go, Postgres, Elasticsearch, Kubernetes, search/ranking, distributed systems, API design

## Education

### BS Computer Science — State University (2014–2018)`;

const THESIS_PLATFORM =
  "Staff backend / platform engineer. Search/ranking, distributed systems, internal platforms. Senior IC track — NOT looking to manage. Seattle or remote. $215k floor. Avoid frontend-only and pure product management.";
const USERSME_PLATFORM =
  "Reads as measured and specific. Senior IC track — not management. Seattle or remote. $215k floor.";

const PROFILE_PLATFORM = `## Search thesis\n${THESIS_PLATFORM}\n\n## Constraints, voice & patterns\n${USERSME_PLATFORM}`;

// Most fixtures share the platform profile; a case that needs different signal
// (e.g. an explicit structural note the shortlist must honor) sets
// `profileOverride` and replaces it wholesale.
function profileFor(fx: { profileOverride?: string | null }): string {
  return fx.profileOverride ?? PROFILE_PLATFORM;
}

// --- Fixtures ---------------------------------------------------------------

type Fixture = {
  name: string;
  notes: string;
  companyName: string;
  companyDescription?: string | null;
  pool: DetailJob[];
  profileOverride?: string | null;
  expect: string;
  mustShortlist?: string[]; // title substrings expected pre-checked
  mustNotShortlist?: string[]; // title substrings that must NOT be pre-checked
  mustNotPass?: string[]; // title substrings that must NOT be closed (pass stance)
  maxShortlist?: number; // hard ceiling on pre-checked count (over-selection guard)
};

export const FIXTURES: Fixture[] = [
  {
    name: "rank-and-select",
    notes:
      "mixed scan verdicts; shortlist the on-thesis ICs, borderline the frontend + the near-duplicate.",
    companyName: "Acme Search",
    pool: [
      dj(
        "r1",
        "Senior Backend Engineer, Search",
        "Remote (US)",
        "STRONG",
        "Search/ranking backend at your level, remote.",
        "Own ranking and retrieval services. Go + Elasticsearch. Remote-first.",
        "$240k–$280k",
      ),
      dj(
        "r2",
        "Staff Software Engineer, Platform",
        "Seattle",
        "STRONG",
        "Platform/infra IC, Seattle, your level.",
        "Build the internal developer platform: CI/CD, service mesh. Go, Kubernetes.",
      ),
      dj(
        "r3",
        "Senior Software Engineer, Distributed Systems",
        "Remote (US)",
        "POSSIBLE",
        "Distributed-systems IC at the candidate's level, remote.",
        "Work on the distributed storage + consensus layer. Go, Rust. Senior IC role.",
        "$240k–$270k",
      ),
      dj(
        "r4",
        "Frontend Engineer, Search UI",
        "Remote (US)",
        "WEAK",
        "Frontend-leaning; survived but off your backend thesis.",
        "Build the search results UI in React/TypeScript. Frontend-focused.",
      ),
      dj(
        "r5",
        "Senior Backend Engineer, Search Infrastructure",
        "Remote (US)",
        "STRONG",
        "Near-duplicate of the Search backend role.",
        "Own the search indexing pipeline + ranking infra. Go, Elasticsearch. (Very similar to the Search backend role.)",
      ),
    ],
    expect:
      "SHORTLIST the on-thesis backend/platform/distributed ICs (r1 Search backend, r2 Platform, r3 Distributed Systems — ~3 picks). The Frontend role (r4) is off the backend thesis → borderline, NOT shortlist. The two near-duplicate Search backend roles (r1, r5) → pre-check ONE and mark the other borderline (don't shortlist both as if distinct). Net 3-4 shortlist; no padding (frontend stays out), no starvation (≥3). proposalNote terse; reasons grounded.",
    mustShortlist: ["Staff Software Engineer, Platform", "Distributed Systems"],
    mustNotShortlist: ["Frontend Engineer"],
  },
  {
    // A prior pass is a DOWNGRADE, not a close. Guards both directions: the
    // model must not pre-check a role the user already set aside, and must not
    // reach for `pass` on the strength of a
    // set-aside — "not this round" is not "would never apply".
    name: "prior-pass-downgrades-never-closes",
    notes:
      "a role the user passed over last round must land borderline — not shortlisted despite its STRONG verdict, and not closed.",
    companyName: "Glint Labs",
    pool: [
      dj(
        "v1",
        "Senior Backend Engineer, Platform",
        "Remote (US)",
        "STRONG",
        "Platform IC, remote, your level.",
        "Own the internal platform + deploy tooling. Go, Kubernetes.",
      ),
      {
        ...dj(
          "v2",
          "Senior Backend Engineer, Payments",
          "Remote (US)",
          "STRONG",
          "Strong scan verdict on paper.",
          "Own the payments ledger + money-movement APIs. Go, Postgres.",
        ),
        priorDeferNote:
          "Set aside last round — you wanted to see the platform roles first.",
      },
      dj(
        "v3",
        "Senior Software Engineer, Distributed Systems",
        "Seattle",
        "POSSIBLE",
        "Distributed systems IC at the candidate's level, Seattle.",
        "Build the distributed storage layer. Go, Rust. Senior IC role.",
        "$240k–$270k",
      ),
    ],
    expect:
      "SHORTLIST v1 (Platform) and v3 (Senior Distributed Systems — on-thesis, at the candidate's level, comp listed). The Payments role (v2) must be BORDERLINE: the user saw it last round and set it aside, which outweighs its STRONG scan verdict for pre-checking — but a set-aside is not a permanent disqualifier, so marking it `pass` (recommending it never be applied to) is ALSO a fail. Its reason should name the history plainly. Pre-checking v2, or passing on it, are both fails.",
    mustShortlist: ["Platform", "Distributed Systems"],
    mustNotShortlist: ["Payments"],
    mustNotPass: ["Payments"],
  },
  {
    name: "no-fabricated-fit",
    notes:
      "a billing/ledger role for a search/platform resume must NOT be shortlisted on invented billing experience.",
    companyName: "Payrail",
    pool: [
      dj(
        "f1",
        "Senior Backend Engineer, Platform",
        "Remote (US)",
        "STRONG",
        "Platform IC matches the resume.",
        "Own the internal platform + service mesh. Go, Kubernetes.",
      ),
      dj(
        "f2",
        "Senior Backend Engineer, Billing & Ledgers",
        "Remote (US)",
        "POSSIBLE",
        "Survived scan, but wants deep billing/ledger experience.",
        "Own the double-entry billing ledger + invoicing pipeline. Requires deep prior payments/ledger experience.",
      ),
      dj(
        "f3",
        "Software Engineer, Distributed Systems",
        "Remote (US)",
        "POSSIBLE",
        "Distributed systems IC.",
        "Build the distributed storage layer. Go, Rust.",
      ),
    ],
    expect:
      "SHORTLIST f1 (Platform) and f3 (Distributed Systems). The Billing & Ledgers role (f2) requires deep payments/ledger experience the resume does NOT have — the candidate is search/ranking/platform, and nothing in their skills or roles touches payments. It must be borderline or pass with HONEST reasoning ('no billing/ledger background — would be a stretch'), NOT a shortlist whose reason fabricates billing experience. A shortlist of f2 claiming relevant billing/ledger background is a fail (fabrication).",
    mustShortlist: ["Platform"],
    mustNotShortlist: ["Billing & Ledgers"],
  },
  {
    name: "seniority-track-discipline",
    notes:
      "Director / Engineering Manager roles must not be shortlisted for a senior-IC candidate who said 'not management'.",
    companyName: "Scale Co",
    pool: [
      dj(
        "s1",
        "Senior Backend Engineer",
        "Remote (US)",
        "STRONG",
        "IC backend, your level, remote.",
        "Own backend services. Go, Postgres.",
      ),
      dj(
        "s2",
        "Staff Software Engineer, Platform",
        "Remote (US)",
        "STRONG",
        "Staff IC platform.",
        "Own the platform/infra. Go, Kubernetes.",
      ),
      dj(
        "s3",
        "Director of Engineering",
        "Seattle",
        "POSSIBLE",
        "Leadership role.",
        "Lead a 30-person engineering org. People management, roadmap, hiring.",
      ),
      dj(
        "s4",
        "Engineering Manager, Backend",
        "Remote (US)",
        "POSSIBLE",
        "People-management role.",
        "Manage a team of 6 backend engineers. 1:1s, performance, delivery.",
      ),
    ],
    expect:
      "SHORTLIST the two IC roles (s1 Senior Backend, s2 Staff Platform). The Director of Engineering (s3) and Engineering Manager (s4) are management roles — the candidate explicitly wants to stay on the IC track ('not looking to manage'), so they must NOT be shortlisted (borderline at most, ideally pass). Shortlisting either management role is a fail (track discipline).",
    mustShortlist: [
      "Senior Backend Engineer",
      "Staff Software Engineer, Platform",
    ],
    mustNotShortlist: ["Director of Engineering", "Engineering Manager"],
  },
  {
    // Regression for the Reddit "12 of 25" over-selection (2026-06-21): a big
    // board where ~10 IC roles are genuinely on-thesis. The shortlist is the
    // 3-5 STRONGEST, not every plausible role — must pre-check ≤5, demote the
    // rest to borderline, and keep management/frontend out (track discipline).
    name: "large-pool-no-over-select",
    notes:
      "big mostly-on-thesis board (Reddit-style) — must pick the 3-5 strongest, not all ~10 plausible ICs.",
    companyName: "Hugecorp",
    pool: [
      dj(
        "h1",
        "Senior Software Engineer, Search Platform",
        "Remote (US)",
        "STRONG",
        "Search/ranking platform IC, your level, remote.",
        "Own retrieval + ranking services at scale. Go, Elasticsearch.",
        "$250k–$300k",
      ),
      dj(
        "h2",
        "Staff Software Engineer, Distributed Storage",
        "Remote (US)",
        "STRONG",
        "Distributed storage IC at staff level.",
        "Own the distributed storage engine. Go, Rust, consensus.",
        "$260k–$320k",
      ),
      dj(
        "h3",
        "Senior Software Engineer, Ranking Infrastructure",
        "Seattle",
        "STRONG",
        "Ranking infra IC, Seattle, your level.",
        "Build the ranking + features pipeline. Go, Python.",
      ),
      dj(
        "h4",
        "Staff Software Engineer, Developer Platform",
        "Remote (US)",
        "STRONG",
        "Internal dev platform IC at staff level.",
        "Own CI/CD + service mesh + deploy tooling. Go, Kubernetes.",
        "$260k–$310k",
      ),
      dj(
        "h5",
        "Senior Software Engineer, Compute Platform",
        "Remote (US)",
        "STRONG",
        "Compute/K8s platform IC.",
        "Build K8s operators + fleet automation. Go.",
      ),
      dj(
        "h6",
        "Senior Software Engineer, Search Indexing",
        "Remote (US)",
        "STRONG",
        "Near-duplicate of the Search Platform role.",
        "Own the search indexing pipeline + ranking infra. Go, Elasticsearch. (Very similar to Search Platform.)",
      ),
      dj(
        "h7",
        "Senior Software Engineer, Data Movement Platform",
        "Remote (US)",
        "POSSIBLE",
        "Data infra IC, on the platform thesis.",
        "Build the data-movement + streaming platform. Go, Kafka.",
      ),
      dj(
        "h8",
        "Senior Software Engineer, GenAI Platform",
        "Remote (US)",
        "POSSIBLE",
        "AI-infra IC, adjacent to the platform thesis.",
        "Build the LLM gateway + RAG pipelines. Python, Go.",
      ),
      dj(
        "h9",
        "Staff Software Engineer, Content Platform",
        "Remote (US)",
        "POSSIBLE",
        "Tier-0 services / feeds infra IC.",
        "Own Tier-0 content services + feeds infra. Go, Python.",
      ),
      dj(
        "h10",
        "Senior Backend Engineer, Ads Serving",
        "Remote (US)",
        "POSSIBLE",
        "Backend IC in ads serving, distributed systems.",
        "Build low-latency ads-serving microservices. Go.",
      ),
      dj(
        "h11",
        "Engineering Manager, Search",
        "Remote (US)",
        "POSSIBLE",
        "Management role.",
        "Manage a team of 7 search engineers. 1:1s, roadmap, hiring.",
      ),
      dj(
        "h12",
        "Director of Engineering, Platform",
        "Seattle",
        "POSSIBLE",
        "Leadership role.",
        "Lead a 40-person platform org. People management, strategy.",
      ),
      dj(
        "h13",
        "Senior Frontend Engineer, Web",
        "Remote (US)",
        "WEAK",
        "Frontend-leaning; off the backend thesis.",
        "Build the web app in React/TypeScript. Frontend-focused.",
      ),
    ],
    expect:
      "About TEN of these are genuinely on-thesis IC roles (search/platform/distributed/data/AI infra) — but the shortlist must be the 3-5 STRONGEST, NOT all ten. Pre-check ≤5 (the sharpest fits — e.g. Search Platform, Distributed Storage, Developer Platform, Ranking Infra) and mark the rest borderline. The two near-duplicate search roles (h1, h6) → pre-check one, borderline the other. Management roles (h11 Engineering Manager, h12 Director) and the Frontend role (h13) must NOT be shortlisted (track/thesis discipline). Pre-checking 6+ is a fail (over-selection — this is the Reddit '12 of 25' regression).",
    mustShortlist: ["Search Platform", "Distributed Storage"],
    mustNotShortlist: [
      "Engineering Manager",
      "Director of Engineering",
      "Frontend",
    ],
    maxShortlist: 5,
  },
];

const SHORTLIST_RUBRIC = `Evaluate the shortlist picks against the INJECTED candidate context shown below. The auditor's intended pattern is included as "Expected".

**MUST (failure flags):**
- **Pick plausibility & seniority/track**: recommended jobs must match the candidate's thesis, resume, seniority, AND track. A candidate who states "senior IC, not management" must NOT get a Director/EM shortlisted. Off-level/off-track/off-domain shortlists are fails.
- **Per-pick reasoning grounded**: each recommended job's reason must ground in specific candidate signal — not a title restatement, and never fabricated. A reason claiming experience the resume doesn't have (e.g. billing/ledger background for a search/platform resume) is a fail (fabrication).
- **Title fidelity**: reasoning must not invent role attributes that contradict the posting.
- **Prior pass respected, and bounded**: a role carrying a "Passed over earlier" note is one the candidate saw last round and left un-checked. Pre-checking it again over that history is a fail. Marking it \`pass\` is ALSO a fail — a set-aside is not "would never apply", and a standing \`pass\` closes the role at commit. \`borderline\` with the history named in the reason is the correct handling. The note is about that ONE role: reading it as a pattern and downgrading other roles on the strength of it is a fail.
- **Pass bar honored**: a standing \`pass\` CLOSES the role when the board is committed. It is reserved for roles with a hard disqualifier in the posting (wrong function, a location the candidate cannot work, a level far outside their range). Marking a merely-outranked, weaker, or unexciting-but-plausible role \`pass\` instead of \`borderline\` is a FAIL — it destroys a role the candidate might have wanted. Passing on a role the scan rated STRONG is allowed but the reason must name a concrete disqualifier the scan missed; a vague or comparative reason there is a fail.

**SHOULD (warn flags):**
- **No over-selection**: the shortlist is the 3-5 STRONGEST, not every plausible role. On a big mostly-on-thesis board, pre-checking 6+ (instead of ranking and keeping the sharpest ~5, with the rest borderline) is a fail — that's the over-selection failure mode. A terse proposalNote whose stated count disagrees with the number actually pre-checked is also a fail.
- **No padding**: shortlisting an off-thesis role (e.g. a frontend role for a backend thesis) just to pad the list is a warn.
- **No starvation**: shortlisting 0-1 when 3+ clearly fit is a warn.
- **Near-duplicate handling**: when two roles are near-identical, pre-check the better-fit one and mark the other borderline rather than shortlisting both as distinct.
- **Proposal note quality**: a terse, specific top-line frame, not "here are some jobs".
- **All-pass appropriateness**: passing on EVERY role is right only when nothing in it is applicable. Doing it while 2+ roles are plausible is a fail. Conversely, an all-\`borderline\` pool is the correct answer to "nothing here stands out" — that is not a fail.

Anchor the rationale to specific picks or omissions. Quote the job titles.`;

const SUB_AGENT_DESCRIPTION = `shortlistJobsSubAgent is the RELATIVE shortlist ranker. The pool it sees has already passed an absolute per-job scan filter (each job carries a STRONG/POSSIBLE/WEAK scan verdict), so every job is at least plausible. Its job is to rank these survivors and recommend the best to apply to, via a single forced output: propose_shortlist_stances — one {reason, stance: pick|borderline|pass} per job, in pool order, plus a terse proposalNote.

What each verdict DOES downstream (the procedure derives all of it; the sub-agent makes no other decision):
- shortlist  → pre-checked in the widget.
- borderline → shown in the widget, un-checked; the user decides.
- pass       → recommended against; the role closes when the user and Hank commit the board.
- all pass   → the board opens with everything in the pass tier; nothing closes until commit.

The sub-agent is a TRANSFORM: no tools, one turn, so it ranked from exactly the context shown below and nothing else. It should: lean on the scan verdict as a prior; aim for 3-5 shortlist when the pool supports it; downgrade (never close) a role the candidate already passed over; respect seniority/track; and never fabricate experience to justify a pick.`;

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

  const email = process.env.AUDIT_USER_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
  const user = email
    ? await prisma.user.findUnique({ where: { email } })
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

  // --only=<substr> runs just the matching fixtures (cheap iteration loop).
  const only = process.argv
    .find((a) => a.startsWith("--only="))
    ?.slice("--only=".length);
  const fixtures = only
    ? FIXTURES.filter((f) => f.name.includes(only))
    : FIXTURES;

  process.stdout.write(
    `\n🔍 Sub-agent audit — shortlistJobsSubAgent\nRun ID: ${runId}\nFixtures: ${fixtures.length}${only ? ` (filtered by "${only}")` : ""}\nUser: ${user.email}\n\n`,
  );

  for (const fx of fixtures) {
    process.stdout.write(`▶ ${fx.name.padEnd(26)} ${fx.notes.slice(0, 56)}\n`);
    const t0 = nowMs();
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
        `   ${verdictGlyph(cr.judge.verdict)} ${cr.judge.verdict.toUpperCase()} score=${cr.judge.score}/5 ` +
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
  const titleById = new Map(fx.pool.map((p) => [p.id, p.title]));

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    "",
    `**Auditor's expected pattern:** ${fx.expect}`,
    "",
    `### Synthetic company: ${fx.companyName}`,
    `### Detail-candidate pool (${fx.pool.length} jobs — each with its scan verdict)`,
    ...fx.pool.map(
      (p) =>
        `- **${p.title}** — _${p.location ?? "no loc"}${p.compensation ? ` · ${p.compensation}` : ""}_ — scan ${p.matchBucket}: ${p.matchReason}\n  summary: ${p.enrichedSummary}`,
    ),
    "",
    `### Injected profile (profile.md)`,
    "```md\n" + profileFor(fx) + "\n```",
    "",
    `### Injected resume summary`,
    "```json\n" + RESUME_PLATFORM.slice(0, 2000) + "\n```",
    "",
    `### Roles the user passed over in an earlier round`,
    fx.pool
      .filter((p) => p.priorDeferNote)
      .map((p) => `- **${p.title}** — ${p.priorDeferNote}`)
      .join("\n") || "_(none)_",
  ].join("\n");

  const result = await runSubAgent(
    shortlistJobsSubAgent,
    {
      companyName: fx.companyName,
      companyDescription: fx.companyDescription ?? null,
      candidates: fx.pool,
      profile: profileFor(fx),
      resume: RESUME_PLATFORM,
      companyNote: null,
    },
    args,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    // Grade the RAW picks — the deterministic cap the procedure applies after
    // this call would otherwise mask an over-pick — but report what would ship.
    const committed = result.output;
    const picks = committed.pickedJobIds;
    const { kept, rawCount, capped } = capShortlistPicks(picks, fx.pool);
    const pickedTitles = picks.map((id) => titleById.get(id) ?? id);
    // Mechanical checks (informational — the judge gates).
    const mustHit = (fx.mustShortlist ?? []).map((sub) => ({
      sub,
      ok: pickedTitles.some((t) => t.toLowerCase().includes(sub.toLowerCase())),
    }));
    const mustMiss = (fx.mustNotShortlist ?? []).map((sub) => ({
      sub,
      ok: !pickedTitles.some((t) =>
        t.toLowerCase().includes(sub.toLowerCase()),
      ),
    }));
    // Separate from mustNotShortlist because they fail in opposite directions:
    // over-picking is recoverable (the user demotes it on the board), while a
    // standing `pass` closes the role at commit. A fixture can demand both of
    // the same title.
    const passedTitles = committed.passedJobIds.map(
      (id) => titleById.get(id) ?? id,
    );
    const mustNotClose = (fx.mustNotPass ?? []).map((sub) => ({
      sub,
      ok: !passedTitles.some((t) =>
        t.toLowerCase().includes(sub.toLowerCase()),
      ),
    }));
    // Over-selection guard: the RAW count (what the model wanted, pre-cap) is
    // what we grade — the deterministic cap would otherwise mask an over-pick.
    const maxOk = fx.maxShortlist == null ? null : rawCount <= fx.maxShortlist;
    const mechLines = [
      `**Mechanical checks** (informational):`,
      fx.maxShortlist != null
        ? `  • model pre-checked ≤${fx.maxShortlist} (raw, pre-cap) → ${rawCount} ${maxOk ? "✓" : "✗ OVER-SELECTED"}`
        : null,
      ...mustHit.map(
        (m) => `  • must shortlist "${m.sub}" → ${m.ok ? "✓" : "✗ MISSED"}`,
      ),
      ...mustMiss.map(
        (m) =>
          `  • must NOT shortlist "${m.sub}" → ${m.ok ? "✓" : "✗ VIOLATED"}`,
      ),
      ...mustNotClose.map(
        (m) => `  • must NOT close "${m.sub}" → ${m.ok ? "✓" : "✗ CLOSED"}`,
      ),
    ]
      .filter((l): l is string => l !== null)
      .join("\n");

    outputMarkdown = [
      `**Picks: ${kept.length} of ${fx.pool.length}**${capped ? ` (model pre-checked ${rawCount}, capped to ${kept.length})` : ""}`,
      `Proposal note: ${committed.proposalNote ?? "_(none)_"}`,
      "",
      mechLines,
      "",
      ...fx.pool.map((p) => {
        const picked = picks.includes(p.id);
        const reason = committed.reasons[p.id] ?? "_(no reason)_";
        return `- [${picked ? "SHORTLIST" : "—"}] **${p.title}** — ${reason}`;
      }),
    ].join("\n");
    outputSummary = `${kept.length}/${fx.pool.length} picks${capped ? ` (raw ${rawCount})` : ""}`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "shortlistJobsSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: SHORTLIST_RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "shortlistJobsSubAgent",
    caseName: fx.name,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `pool=${fx.pool.length}`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

function verdictGlyph(v: string): string {
  if (v === "pass") return "✓";
  if (v === "fail") return "✗";
  return "⚠";
}
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const { readFile } = await import("fs/promises");
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

if (isEntrypoint(import.meta.url))
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
