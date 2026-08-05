// Audit harness for runPreScan (PRE_SCAN pt1 — metadata-only bucketing).
//
// Each fixture is FULLY SELF-CONTAINED: a SYNTHETIC company + SYNTHETIC NEW-job
// pool + a candidate context (thesis / patterns / resume) handed straight to the
// procedure as its `context`. That fixes the two problems that blocked this
// audit: (1) the bucketing graded against the host admin's live thesis, and
// (2) "stale empty NEW pools" — real companies churn their NEW-status
// JobInteractions, so a real-pool fixture silently goes empty. Synthetic pools
// never drift.
//
// There's no bypass flag involved: `context` is the procedure's normal input,
// just supplied instead of read. Passing it also runs the chunk sub-agent
// closed-book (no read tools), so the model buckets from exactly this pool.
//
// Coverage (the calls the rubric cares about):
//   - location-defer + remote-doesn't-rescue-role-type + PM-is-not-eng (mixed pool)
//   - the RARE valid location skip (an explicit user-named hard-skip location)
//   - domain veto (a defense company — every role skips on domain)
//   - profile.md role allergy (FDE / Solutions Engineer)
//   - no-over-skip sanity (all-remote engineering pool → all keep)
//   - cold-start bail (no thesis → mode=cold_start, no LLM)
//
// Multi-try (TRIES) preserved: the location calls are stochastic, so the judge
// grades TYPICAL behavior across tries (a one-off bad draw is a warn, not a fail).
//
// Run: pnpm tsx scripts/regression/sub-agents/pre-scan.ts --live

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import {
  runPreScan,
  type PreScanResult,
} from "../../../src/server/procedures/registry/preScan";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

import type { RoleAttrs } from "../../../src/server/entities/jobs/roleAttrs";

// The two former profile notes (a "search thesis" + an "about me") are one
// profile.md now. Fixtures still author the halves separately — they're
// different kinds of content and it keeps each case readable — and this stitches
// them into the single sectioned note the sub-agent actually receives.
function mergeProfile(thesis: string, patterns: string): string {
  return `## Search thesis\n${thesis}\n\n## Constraints, voice & patterns\n${patterns}`;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TRIES = 3;

// --- Synthetic pool builder -------------------------------------------------

type LeanJob = RoleAttrs & {
  id: string;
  title: string;
  attributes?: unknown;
};
function j(
  id: string,
  title: string,
  location: string | null,
  department: string | null = null,
  compensation: string | null = null,
  employmentType: string | null = "Full-time",
): LeanJob {
  return {
    id,
    title,
    location,
    department,
    compensation,
    employmentType,
    attributes: null,
  };
}

// --- Personas ---------------------------------------------------------------

// The user's background exactly as prod stores it: the resume.md memory note,
// full detail, markdown.
const RESUME_MOBILE = `## Roles

### Staff Mobile Engineer — Acme (2021–present)
- Owned the iOS app architecture: modularization, startup-time budgets, offline sync.
- Built and ran the mobile CI/release pipeline for weekly App Store + Play Store ships.

### Senior Mobile Engineer — Meridian (2018–2021)
- Led the Android rewrite to Kotlin + Jetpack Compose.
- Cut cold-start time 40% and crash rate to under 0.1%.

## Skills
Swift, Kotlin, SwiftUI, Jetpack Compose, React Native, mobile CI/CD, app performance

## Education

### BS Computer Science — State University (2014–2018)`;

const THESIS_SOFT_NYC =
  "Senior mobile engineer — iOS and Android, plus the mobile platform (build pipelines, release tooling, performance). NYC or remote preferred, but open to strong roles elsewhere. Avoid sales, marketing, recruiting, and pure product management.";
const USERSME_PLAIN =
  "Plain-spoken, ships-focused voice. $175k comp floor. NYC/remote preferred but not a hard rule. Avoids gambling apps.";

const THESIS_HARD_NYC =
  "Senior mobile engineer — iOS and Android, plus the mobile platform (build pipelines, release tooling, performance). HARD location: NYC or fully remote ONLY — will not relocate anywhere else and will not take an on-site/hybrid role outside NYC. Avoid sales, marketing, recruiting, and pure product management.";
const USERSME_HARD_NYC =
  "Blunt, low-ceremony voice. $300k comp floor. NYC or fully-remote only — no relocation to any other city, ever.";

// --- Fixtures ---------------------------------------------------------------

type Fixture = {
  name: string;
  notes: string;
  companyName: string;
  profile: string | null;
  pool: LeanJob[];
  expect: string;
};

export const FIXTURES: Fixture[] = [
  {
    name: "mixed-keep-bias",
    notes:
      "engineering roles kept regardless of city/hybrid (location deferred to scan); sales/PM/recruiter/design skipped not_a_match; remote doesn't rescue a sales role.",
    companyName: "Acme Cloud",
    profile: mergeProfile(THESIS_SOFT_NYC, USERSME_PLAIN),
    pool: [
      j(
        "a1",
        "Senior iOS Engineer",
        "San Francisco, California • On-site",
        "Engineering",
      ),
      j("a2", "Staff Android Engineer", "New York City", "Engineering"),
      j("a3", "Mobile Platform Engineer", "Remote (US)", "Engineering"),
      j("a4", "Senior Mobile Engineer", "Austin, TX • Hybrid", "Engineering"),
      j("a5", "React Native Engineer", "Toronto, ON • Hybrid", "Engineering"),
      j(
        "a6",
        "Account Executive",
        "San Francisco, California • On-site",
        "Sales",
      ),
      j("a7", "Enterprise Sales Manager", "Remote (US)", "Sales"),
      j("a8", "Senior Product Manager", "New York City", "Product"),
      j("a9", "Technical Recruiter", "Remote (US)", "People"),
      j(
        "a10",
        "Brand Designer",
        "San Francisco, California • On-site",
        "Design",
      ),
    ],
    expect:
      "KEEP all 5 engineering roles (a1–a5) — bare-city, hybrid, and remote are ALL deferred to the scan body-read, never location_mismatch here. SKIP:not_a_match the 5 non-engineering roles (Account Executive, Enterprise Sales Manager — remote does NOT rescue a sales role, Senior Product Manager — PM is not engineering, Technical Recruiter, Brand Designer). ZERO location_mismatch skips.",
  },
  {
    name: "hard-location-skip",
    notes:
      "the rare VALID location skip: an explicit user-named hard-skip location on an on-site role.",
    companyName: "Sunset Media",
    profile: mergeProfile(
      THESIS_SOFT_NYC +
        " HARD no: Los Angeles, on-site — will not consider an LA on-site role under any circumstances.",
      USERSME_PLAIN + " Hard no on LA on-site specifically.",
    ),
    pool: [
      j(
        "b1",
        "Senior iOS Engineer",
        "Los Angeles, California • On-site",
        "Engineering",
      ),
      j("b2", "Staff Mobile Engineer", "Remote (US)", "Engineering"),
      j(
        "b3",
        "Android Engineer",
        "San Francisco, California • On-site",
        "Engineering",
      ),
    ],
    expect:
      "SKIP:location_mismatch the LA on-site role (b1) — it explicitly matches the user's stated hard-skip location. KEEP b2 (remote) and b3 (SF — a non-LA city is deferred to scan, NOT a location_mismatch).",
  },
  {
    name: "domain-deadend-all-skip",
    notes:
      "defense company; thesis hard-avoids defense → every engineering role skips not_a_match on DOMAIN.",
    companyName: "Forterra Defense Systems",
    profile: mergeProfile(
      THESIS_SOFT_NYC +
        " Hard avoid: defense, weapons, and hardware/automotive companies — dead-ends, skip regardless of how on-thesis the title is.",
      USERSME_PLAIN + " Will not work in defense/weapons.",
    ),
    pool: [
      j(
        "c1",
        "Senior Mobile Engineer",
        "San Francisco, California • On-site",
        "Mission Software",
      ),
      j(
        "c2",
        "Staff Android Engineer",
        "Remote (US)",
        "Autonomy & Weapons Systems",
      ),
      j("c3", "iOS Platform Engineer", "New York City", "Air Defense"),
    ],
    expect:
      "ALL three roles SKIP:not_a_match on DOMAIN — a defense company's engineering roles are still defense, and the thesis hard-avoids it; an on-thesis title or a remote location never rescues an avoided-domain company. The verdicts are the whole output; there is no company-level close to emit.",
  },
  {
    name: "usersme-allergy-skip",
    notes:
      "profile.md names FDE + Solutions Engineer as avoid → those titles skip not_a_match even at an on-thesis company.",
    companyName: "Glean Data",
    profile: mergeProfile(
      THESIS_SOFT_NYC,
      USERSME_PLAIN +
        " Avoid: Forward Deployed Engineer (FDE) and Solutions Engineer roles — learned these aren't a fit (too customer-facing).",
    ),
    pool: [
      j("d1", "Senior iOS Engineer", "Remote (US)", "Engineering"),
      j(
        "d2",
        "Forward Deployed Engineer",
        "New York City",
        "Field Engineering",
      ),
      j(
        "d3",
        "Solutions Engineer",
        "San Francisco, California • On-site",
        "Customer Engineering",
      ),
      j(
        "d4",
        "Mobile Platform Engineer",
        "San Francisco, California • On-site",
        "Engineering",
      ),
    ],
    expect:
      "KEEP the core engineering roles (d1 Senior iOS, d4 Mobile Platform). SKIP:not_a_match the Forward Deployed Engineer (d2) and Solutions Engineer (d3) — profile.md has flagged these role types as avoid, which outranks the on-thesis company.",
  },
  {
    name: "all-remote-eng-keep",
    notes:
      "clean all-remote engineering pool → all keep (no-over-skip sanity).",
    companyName: "Distributed Inc",
    profile: mergeProfile(THESIS_SOFT_NYC, USERSME_PLAIN),
    pool: [
      j("e1", "Senior iOS Engineer", "Remote (US)", "Engineering"),
      j("e2", "Staff Mobile Engineer, Platform", "Remote (US)", "Engineering"),
      j("e3", "Android Engineer", "Remote", "Engineering"),
    ],
    expect: "KEEP all three — on-thesis engineering, all remote. ZERO skips.",
  },
  {
    name: "foreign-city-bare-keep",
    notes:
      "bare foreign + US city engineering roles (no arrangement tag) must all be KEPT — a bare city is deferred to the scan body-read regardless of country. Reproduces the location_overskip_foreign_city bug (18× in the runtime audit).",
    companyName: "Globe Systems",
    profile: mergeProfile(THESIS_SOFT_NYC, USERSME_PLAIN),
    pool: [
      j("g1", "Senior iOS Engineer", "London, UK", "Engineering"),
      j("g2", "Mobile Platform Engineer", "Berlin, Germany", "Engineering"),
      j("g3", "Staff Android Engineer", "Toronto, Canada", "Engineering"),
      j("g4", "Mobile Engineer", "Bangalore, India", "Engineering"),
      j("g5", "Software Engineer, iOS", "Seattle, WA", "Engineering"),
      j("g6", "Senior Mobile Engineer", "Remote (US)", "Engineering"),
    ],
    expect:
      "KEEP all 6 — every one is a bare city with no on-site/hybrid arrangement tag (or remote), so location is deferred to the scan body-read. Foreign cities (London/Berlin/Toronto/Bangalore) are NOT location_mismatch — a bare city is a bare city. ZERO location_mismatch skips.",
  },
  {
    name: "all-onsite-elsewhere-location-skips",
    notes:
      "hard NYC/remote-only candidate; every role is on-site in a ruled-out city (explicit on-site tags). Tests that a full wipe stays a set of job-level location skips — pre-scan has no company-level verdict to over-reach with.",
    companyName: "Bayview Robotics",
    profile: mergeProfile(THESIS_HARD_NYC, USERSME_HARD_NYC),
    pool: [
      j(
        "h1",
        "Senior iOS Engineer",
        "San Francisco, California • On-site",
        "Engineering",
      ),
      j(
        "h2",
        "Mobile Platform Engineer",
        "Palo Alto, CA • On-site",
        "Engineering",
      ),
      j(
        "h3",
        "Staff Android Engineer",
        "Mountain View, CA • On-site",
        "Engineering",
      ),
    ],
    expect:
      "All 3 are on-site in ruled-out cities → job-level skip:location_mismatch is acceptable. Pre-scan emits per-job verdicts only, so a full wipe is just three skips — there is no company-level verdict to get wrong.",
  },
  {
    name: "cold-start-bail",
    notes:
      "no profile at all → pre-scan bails with mode=cold_start (no LLM bucketing).",
    companyName: "Nascent Co",
    profile: null,
    pool: [
      j("f1", "Senior iOS Engineer", "Remote (US)", "Engineering"),
      j("f2", "Mobile Platform Engineer", "New York City", "Engineering"),
    ],
    expect:
      "mode=cold_start — with no thesis AND no profile.md, pre-scan must bail (no bucketing, company left for the profile step). Every try should return cold_start.",
  },
];

const SUB_AGENT_DESCRIPTION = `runPreScan is PRE_SCAN pt1 — bulk metadata-only filtering at watchlist-add time. It reads the user's profile (profile.md), resume summary, and the company's NEW-job pool (title/location/department/comp/type — NOT bodies). Each chunk emits verdicts (one per job): keep, skip:not_a_match, skip:location_mismatch, skip:other, and nothing else — it returns survivingJobIds + the closed buckets, and decides NOTHING about the company (its callers pick READY/CAUGHT_UP from the survivor count; pre-scan can no longer close a company at all). In this audit the candidate context AND the job pool are INJECTED (synthetic), and the in-loop read tools are off, so the model bucketed from exactly the pool + thesis shown.

The pre-scan should:
- Skip on STRUCTURAL disqualifiers visible in metadata: role-type misses (sales/marketing/recruiting/PM for an engineer), avoided-domain companies (defense/hardware/automotive), profile.md role allergies.
- DEFER location: keep bare-city / hybrid / on-site / remote roles — only skip:location_mismatch for an explicit user-named HARD-skip location. Remote does NOT rescue an off-thesis role type.
- Bail mode=cold_start when profile.md is empty.`;

const RUBRIC = `Evaluate runPreScan's per-job bucketing (keep / skip:not_a_match / skip:location_mismatch / skip:other) against the INJECTED thesis + the job metadata. The auditor's intended pattern is included as "Expected".

**You are shown ${TRIES} independent tries of the same pool** (the sub-agent is stochastic on borderline location calls). Judge TYPICAL behavior across the tries.

**Over-skip vs under-skip — the harm asymmetry:**
- **Over-skip** (skipping a role that should be kept) is the harmful direction — pre-scan is metadata-only with NO downstream recovery. Skipping a bare-city / hybrid / on-site / remote role on location is an over-skip; pre-scan defers ALL location calls to the scan body-read EXCEPT an explicit user-named hard-skip location.
- **Under-skip** (keeping a borderline role) is SAFE — the scan body-read catches it.

**Scoring across the ${TRIES} tries:**
- **PASS** — consistently well-calibrated (matches the Expected pattern most/all tries).
- **WARN (not fail)** for: a stochastic over/under-skip that appears in only SOME tries (if ≥1 try gets it right, the agent knows the call — don't fail unlucky draws, even a full-company wipe in a minority of tries). Also warn-level: weak rationales.
- **FAIL** — an error that is BOTH unambiguous AND consistent (most/all tries): skipping an explicitly **Remote** role as location_mismatch every try; keeping an obvious sales/recruiting/PM role for an engineer every try; NO try applying the clear defense/hardware domain dead-end; skipping a non-hard-skip city as location_mismatch in every try; missing the cold_start bail. If even ONE try handles it correctly, downgrade to WARN.

**Also weigh (warn-level):** rationale specificity; honoring profile.md allergies; domain veto correctness.

Anchor your rationale to specific keep/skip decisions across the tries.`;

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

  const judgeApiKey = await resolveAnthropicApiKey(userId);
  const judgeClient = new Anthropic({ apiKey: judgeApiKey });

  const runId = `audit-${nowMs().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — runPreScan\n` +
      `Run ID: ${runId}\nFixtures: ${FIXTURES.length}\nUser: ${user.email}\n\n`,
  );

  for (const fx of FIXTURES) {
    const t0 = nowMs();
    process.stdout.write(`▶ ${fx.name.padEnd(22)} ${fx.notes.slice(0, 60)}\n`);
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
  const titleById = new Map(fx.pool.map((p) => [p.id, p.title]));

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    "",
    `**Auditor's expected pattern:** ${fx.expect}`,
    "",
    `### Synthetic company: ${fx.companyName}`,
    `### NEW job pool (${fx.pool.length} jobs)`,
    ...fx.pool.map(
      (p) =>
        `- **${p.title}** — _${p.location ?? "no loc"} · ${p.department ?? "no dept"} · ${p.employmentType ?? "?"}_`,
    ),
    "",
    `### Injected profile (profile.md)`,
    fx.profile ? "```md\n" + fx.profile + "\n```" : "_(empty — cold start)_",
  ].join("\n");

  const results = await Promise.all(
    Array.from({ length: TRIES }, () =>
      runPreScan({
        companyId: `synthetic-${fx.name}`,
        userId: args.userId,
        sessionId: args.sessionId,
        dryRun: true,
        context: {
          companyName: fx.companyName,
          profile: fx.profile,
          resume: RESUME_MOBILE,
          jobs: fx.pool,
        },
      }).catch((e: unknown): PreScanResult => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        turns: 0,
      })),
    ),
  );

  const outputMarkdown = [
    `_${TRIES} independent tries of the same pool (the sub-agent is stochastic):_`,
    "",
    ...results.map((r, i) => renderTry(r, titleById, i + 1)),
  ].join("\n\n");
  const outputSummary =
    `${TRIES} tries — ` +
    results
      .map((r) =>
        !r.ok
          ? "err"
          : r.mode === "cold_start"
            ? "cold"
            : `${r.survivingJobs}/${fx.pool.length} kept`,
      )
      .join(" | ");

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "preScanJobBatchSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "preScanJobBatchSubAgent",
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

function renderTry(
  result: PreScanResult,
  titleById: Map<string, string>,
  tryNum: number,
): string {
  if (!result.ok) return `**Try ${tryNum}: ERROR** — ${result.error}`;
  if (result.mode === "cold_start") {
    return `**Try ${tryNum}: cold_start** (no thesis — pt1 bailed without running)`;
  }
  const survivors = result.survivingJobIds.map((id) => titleById.get(id) ?? id);
  const lines: string[] = [
    `**Try ${tryNum}** — ${result.survivingJobs} kept / ${result.skippedJobs} skipped`,
  ];
  for (const b of result.skipBuckets) {
    lines.push(`- skip:${b.reason}`);
    for (const j of b.jobs) {
      lines.push(`  · ${titleById.get(j.id) ?? j.id} — _${j.closeNote}_`);
    }
  }
  lines.push(
    `- kept (${survivors.length}): ${survivors.join("; ") || "(none)"}`,
  );
  if (result.notes.length > 0)
    lines.push(`- notes: ${result.notes.join(" | ")}`);
  return lines.join("\n");
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
