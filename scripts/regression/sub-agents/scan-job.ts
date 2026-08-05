// Audit harness for scanJobSubAgent (transform — scan-step pass 2, user-dependent).
//
// Per-job ABSOLUTE match verdict: decision = "match" (+ STRONG/POSSIBLE/WEAK) or
// "skip" (+ reason). Each fixture pairs a REAL Exa job (its summary/location is
// stable global data we keep) with a synthetic candidate (thesis / patterns /
// resume), both handed to the sub-agent as its plain `input`. That decouples
// the pinned decision from whatever a test persona's thesis happens to
// be — exactly what made these pins coin-flips: a real thesis like "NYC or
// fully-remote only, hard no on non-fitting locations" makes an SF-onsite role
// legitimately flip between match and skip depending on the reader's memory that day.
//
// Resolution here: ONE coherent thesis PER FIXTURE.
//   - RELOCATION-OPEN candidate → an SF-onsite strong-domain role is a MATCH.
//   - GEO-LOCKED (NYC/remote-only) candidate → the SAME role is a SKIP
//     (LOCATION_MISMATCH).
// Both pins are now internally consistent with the candidate the fixture injects.
//
// The anti-fabrication guard (never invent a past-skip pattern) stays in the
// sub-agent prompt and is exercised by the no-past-skips fixtures + the rubric.

import {
  ROLE_ATTR_SELECT,
  formatRoleAttrs,
  toRoleAttrs,
} from "../../../src/server/entities/jobs/roleAttrs";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { scanJobSubAgent } from "../../../src/server/subagents/registry/scanJob";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";

// The two former profile notes (a "search thesis" + an "about me") are one
// profile.md now. Fixtures still author the halves separately — they're
// different kinds of content and it keeps each case readable — and this stitches
// them into the single sectioned note the sub-agent actually receives.
function mergeProfile(thesis: string, patterns: string): string {
  return `## Search thesis\n${thesis}\n\n## Constraints, voice & patterns\n${patterns}`;
}

// --- Personas (injected candidate context) ---------------------------------

type Persona = {
  label: string;
  profile: string;
  resume: string;
};

const RELO_OPEN: Persona = {
  label: "relocation-open backend / distributed-systems IC",
  profile: mergeProfile(
    "Senior backend / distributed-systems engineer — consensus, sharded datastores, high-throughput services, and the infrastructure they run on. Based in Denver; prefer NYC or remote, but OPEN TO RELOCATING for the right distributed-systems team — onsite is fine if the people and the problems are strong. Avoid sales, marketing, design, and pure product management.",
    "Writes plainly and asks a lot of 'why' questions. $205k comp floor. Open to relocation for a strong backend team; will take onsite for the right role. Avoids gambling and crypto.",
  ),
  resume: `## Roles

### Senior Backend Engineer — Nimbus (2020–present)
- Built the sharded metadata store behind a multi-tenant API (Go, Postgres, Raft).
- Owned the event-queue backbone and its exactly-once delivery.

### Backend Engineer — Cleo (2017–2020)
- Led the monolith→services split for the payments path.

## Skills
Go, Postgres, Kafka, gRPC, Raft, distributed systems, API design`,
};

const GEO_LOCKED: Persona = {
  label: "geo-locked NYC/remote-only SRE / platform IC",
  profile: mergeProfile(
    "Staff site-reliability / platform engineer. Reliability, incident response, Kubernetes, and the internal deploy platform. HARD location requirement: NYC or fully-remote ONLY. Will NOT relocate and will NOT take onsite roles outside NYC, full stop. Avoid sales, design, and pure product management.",
    "Terse, checklist-driven voice. $240k comp floor. Hard no on any non-NYC onsite role — won't relocate, period. Remote or NYC only.",
  ),
  resume: `## Roles

### Staff Site Reliability Engineer — Halyard (2019–present)
- Ran the on-call and SLO program across ~200 services; cut pager volume by half.
- Owned the Kubernetes platform and the multi-cluster rollout tooling.

## Skills
Kubernetes, Terraform, Prometheus, Go, incident response, SLOs, platform engineering`,
};

// Actively relocating TO the target metro — an on-site role IN that metro is a
// YES. Reproduces the prod bug where a NYC-onsite role was closed
// LOCATION_MISMATCH for a user whose thesis said "relocating to NYC".
const NYC_RELO: Persona = {
  label: "relocating-to-NYC data / ML infrastructure IC (NYC on-site = yes)",
  profile: mergeProfile(
    "Staff data / ML infrastructure engineer. Batch + streaming pipelines, feature stores, the metrics/logs ingestion path, and query performance. Location: NYC or fully remote. Currently in Seattle and ACTIVELY RELOCATING to New York — an NYC on-site or hybrid role is a YES, that's where I'm moving. Will not relocate anywhere other than NYC. Avoid sales, design, and pure product management.",
    "Precise, numbers-first voice. $260k comp floor. Relocating to NYC — NYC on-site is fine (moving there). Remote also fine. No city other than NYC.",
  ),
  resume: `## Roles

### Staff Data Infrastructure Engineer — Meridian (2020–present)
- Owned the streaming ingestion + indexing path for ~5M events/sec of logs and metrics.
- Built the feature store and the batch pipelines feeding it.

## Skills
Spark, Flink, Kafka, Airflow, Parquet, data pipelines, query optimization`,
};

// A NYC-or-remote-only candidate whose thesis includes a "don't close COMPANIES
// for location" caveat. That caveat must NOT leak into the per-role geo call — a
// pure on-site-elsewhere role is still a skip. This is the exact shape that
// over-matched a bullseye SF-onsite role STRONG in prod.
const NYC_REMOTE_SOFT: Persona = {
  label:
    "NYC-or-remote-only IC with a don't-close-companies-on-location caveat",
  profile: mergeProfile(
    "Senior software engineer with a platform / infrastructure focus — services, developer tooling, search, and networking — but comfortable across the stack, including the product and frontend surfaces on top. NYC-based or fully remote only. Currently in San Diego; actively looking to relocate to NYC or work remote. No San-Diego-only roles. Don't close companies for location mismatch unless there's hard evidence the company never hires in NYC/remote — just because current postings are in SF/Seattle doesn't mean they won't post NYC/remote roles.",
    "Understated, weighs-both-sides voice. $195k comp floor. NYC or fully-remote only — relocating to NYC. Will not take an SF/Seattle/other-city on-site or hybrid role.",
  ),
  resume: `## Roles

### Senior Software Engineer, Platform — Acme (2019–present)
- Owned the internal developer platform: build/CI, service scaffolding, and the search tier.
- Shipped product-facing features on the web app alongside the platform work.

## Skills
Go, TypeScript, Kubernetes, Elasticsearch, developer tooling, full-stack`,
};

// Fully-remote-only, won't relocate anywhere. A multi-city role that ALSO lists
// a US-Remote option must MATCH on remote — reproduces the NVIDIA prod bug where
// scan skipped a "Remote (US)" role LOCATION_MISMATCH by fixating on a listed city.
const REMOTE_ONLY: Persona = {
  label:
    "remote-only security engineering IC, no relocation (remote option must rescue)",
  profile: mergeProfile(
    "Senior security engineer — detection engineering, security data pipelines, and threat analytics. FULLY REMOTE ONLY — will not relocate and will not take any on-site or hybrid role, ever. Based in Portland, OR and staying. Avoid sales, design, and pure product management.",
    "Dry, evidence-driven voice. $185k comp floor. Remote-only, no relocation under any circumstances. A role is fine as long as fully-remote is an option.",
  ),
  resume: `## Roles

### Senior Security Engineer — Cleo (2019–present)
- Built the detection pipeline over security event logs (SIEM + custom analytics).
- Owned threat-detection rules and the alert-triage tooling.

## Skills
Detection engineering, SIEM, Python, Go, security data pipelines, threat analytics`,
};

// --- Fixtures ---------------------------------------------------------------

type Fixture = {
  name: string;
  slug: string;
  titleContains: string;
  // Disambiguate SF vs Singapore (and similar) variants of the same title.
  locationContains?: string;
  persona: Persona;
  companyNote?: string | null;
  notes: string;
  expectDecision?: "match" | "skip";
  expectCloseReason?: "LOCATION_MISMATCH" | "NOT_A_MATCH";
};

export const FIXTURES: Fixture[] = [
  {
    name: "sales-off-thesis-skip",
    slug: "exa",
    titleContains: "Account Executive",
    locationContains: "San Francisco",
    persona: RELO_OPEN,
    notes: "sales role for an engineering candidate → skip (role type)",
    expectDecision: "skip",
    expectCloseReason: "NOT_A_MATCH",
  },
  {
    name: "design-off-thesis-skip",
    slug: "exa",
    titleContains: "Brand Designer",
    locationContains: "San Francisco",
    persona: RELO_OPEN,
    notes: "design role for an engineering candidate → skip (role type)",
    expectDecision: "skip",
    expectCloseReason: "NOT_A_MATCH",
  },
  {
    name: "infra-relocation-open-match",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    locationContains: "San Francisco",
    persona: RELO_OPEN,
    notes:
      "on-domain infra eng, SF-onsite; candidate is relocation-open → match (geo works)",
    expectDecision: "match",
  },
  {
    name: "infra-geo-locked-skip",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    locationContains: "San Francisco",
    persona: GEO_LOCKED,
    notes:
      "SAME SF-onsite infra eng, but candidate is NYC/remote-only → skip (location)",
    expectDecision: "skip",
    expectCloseReason: "LOCATION_MISMATCH",
  },
  {
    name: "backend-on-thesis-match",
    slug: "exa",
    titleContains: "Software Engineer, Backend",
    locationContains: "San Francisco",
    persona: RELO_OPEN,
    notes:
      "on-domain backend eng at the candidate's level; relocation-open → match",
    expectDecision: "match",
  },
  {
    name: "devrel-borderline-no-pin",
    slug: "exa",
    titleContains: "Developer Relations",
    locationContains: "San Francisco",
    persona: RELO_OPEN,
    notes:
      "DevRel — adjacent to engineering, genuinely borderline (no pin; judge grades reason quality)",
  },
  // --- Regression fixtures for the 2026-07 location-mismatch fix ---------------
  {
    name: "nyc-onsite-relocation-target-match",
    slug: "datadog",
    titleContains: "Staff Software Engineer - Logs Management",
    locationContains: "New York",
    persona: NYC_RELO,
    notes:
      "NYC on-site Staff SWE; candidate is actively relocating TO NYC → MATCH. This is the exact prod bug (NYC-onsite closed LOCATION_MISMATCH for a relocating-to-NYC user). NYC is a workable/target metro — geo PASSES even on-site.",
    expectDecision: "match",
  },
  {
    name: "remote-role-matches-remote-only",
    slug: "stripe",
    titleContains: "Security Analytics Infrastructure",
    locationContains: "Remote",
    persona: REMOTE_ONLY,
    notes:
      "Unambiguously fully-remote SWE role (US - Remote); candidate is remote-only, no relocation → MATCH. Remote ALWAYS passes geo — a fully-remote role is never a LOCATION_MISMATCH. (Guards against the class where scan fixated on a company/city and skipped a remote role.)",
    expectDecision: "match",
  },
  {
    name: "strong-sf-onsite-still-location-skip",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    locationContains: "San Francisco",
    persona: NYC_REMOTE_SOFT,
    notes:
      "BULLSEYE SF-onsite infra role for a NYC/remote-only candidate whose thesis ALSO says 'don't close companies for location'. The role must SKIP (LOCATION_MISMATCH) — a ruled-out on-site location beats a perfect role, and the company-level caveat must NOT leak into the per-role call. Reproduces the Cognition SF-onsite→STRONG over-match found in the rescan.",
    expectDecision: "skip",
    expectCloseReason: "LOCATION_MISMATCH",
  },
  {
    name: "multi-city-onsite-with-nyc-option-match",
    slug: "cognition",
    titleContains: "Product Engineer",
    locationContains: "New York",
    persona: NYC_REMOTE_SOFT,
    notes:
      "Multi-city ON-SITE role 'San Francisco • New York City • On-site' for the NYC/remote-only candidate relocating to NYC → MATCH. NYC is a listed option AND the candidate's target metro, so they pick NYC; the ruled-out SF option is irrelevant (multi-location: ANY workable option passes). Reproduces the exact prod bug — flash reasoned 'NYC on-site passes geo' in its reason text but emitted skip anyway (decision-before-reasoning), and mis-read 'NYC-based or fully remote' as 'remote only'. Guards the analysis-first schema reorder + the multi-city-onsite geo clause.",
    expectDecision: "match",
  },
  {
    name: "hybrid-elsewhere-still-location-skip",
    slug: "vercel",
    titleContains: "Next.js",
    locationContains: "Hybrid",
    persona: NYC_REMOTE_SOFT,
    notes:
      "Strong SF-HYBRID SWE role for the NYC/remote-only candidate → must SKIP (LOCATION_MISMATCH). Hybrid is NOT remote — it requires being in the SF office multiple days/week. Reproduces the second over-match class (Harvey/Replit/Vercel hybrid-elsewhere → STRONG) found in the rescan re-dry-run.",
    expectDecision: "skip",
    expectCloseReason: "LOCATION_MISMATCH",
  },
  {
    name: "foreign-onsite-still-location-skip",
    slug: "algolia",
    titleContains: "Search Infrastructure",
    locationContains: "Paris",
    persona: NYC_REMOTE_SOFT,
    notes:
      "Strong infra role in Paris, France for a US-based NYC/remote-only candidate → SKIP (LOCATION_MISMATCH). A foreign metro is OUTSIDE the candidate's workable region; 'remote' inside a foreign posting is foreign-remote, which a US-only candidate cannot take. Reproduces the London/Paris/Bangalore over-match from the rescan apply.",
    expectDecision: "skip",
    expectCloseReason: "LOCATION_MISMATCH",
  },
  {
    name: "foreign-remote-still-location-skip",
    slug: "nvidia",
    titleContains: "Infrastructure & Network Automation",
    locationContains: "Remote",
    persona: NYC_REMOTE_SOFT,
    notes:
      "Role remote-eligible only in EMEA countries (Germany/Spain/Poland/… Remote) for a US-based candidate → SKIP (LOCATION_MISMATCH). Foreign remote is not the candidate's remote — the word 'remote' must NOT auto-pass an out-of-region role.",
    expectDecision: "skip",
    expectCloseReason: "LOCATION_MISMATCH",
  },
];

const SUB_AGENT_DESCRIPTION = `scanJobSubAgent makes an ABSOLUTE per-job match call for ONE role against ONE candidate (the user's thesis/resume/patterns/past-skips). It is NOT a ranking — a later step ranks the matches. Output: decision="match" (+ bucket STRONG/POSSIBLE/WEAK + one-line user-facing reason) OR decision="skip" (+ closeReason NOT_A_MATCH/LOCATION_MISMATCH/OTHER + reason).

Skip when ANY hold: role type/domain off-thesis (sales/CS/support/pure-PM for an engineer; Engineering Manager IS in scope, Product Manager is not), the role's geo can't work for THIS candidate (an onsite-elsewhere role for a candidate who won't relocate), seniority >2 levels off, a hard-pass from memory, or the company's DOMAIN is an off-thesis avoid. It judges ONE role for ONE candidate — it has NO company-wide skip history and must not invent one. Otherwise match: STRONG = clear fit at the right level, POSSIBLE = plausible, WEAK = survived but a stretch (e.g. on-domain but a geo stretch the relocation-open candidate would accept). The reason is shown to the user — plain English, no enum names or jargon.`;

const RUBRIC = `Evaluate the match verdict against the role and the INJECTED candidate (thesis / patterns / resume) shown in context. The candidate differs per fixture — judge geo strictly against THIS candidate's stated stance.

**MUST (failure flags):**
- **Decision correctness**: An off-thesis role type (sales/marketing/design/support/pure-PM for an engineering candidate) must be "skip". An on-domain engineering role at the candidate's level whose location the candidate WOULD accept must be "match". Getting the binary decision clearly wrong is a fail.
- **Geo judged against THIS candidate**: For a RELOCATION-OPEN / onsite-OK candidate, an SF-onsite on-domain role is a MATCH (a geo stretch at worst — bucket WEAK/POSSIBLE — not a skip). For a candidate whose thesis is a HARD "NYC or fully-remote only, won't relocate", the SAME SF-onsite role is a correct LOCATION_MISMATCH skip. Mixing these up (skipping the relo-open candidate on location, or matching the geo-locked candidate onto an onsite-elsewhere role) is a fail.
- **Relocation target passes; remote always passes**: An on-site role IN a city the candidate said they're relocating to (e.g. NYC for a "relocating to NYC" candidate) is a MATCH — skipping it LOCATION_MISMATCH is a fail. A role that offers a fully-remote option is a MATCH for a remote-OK candidate regardless of what cities it also lists — skipping it on location because it names a city is a fail (the NVIDIA bug).
- **Skip-reason accuracy**: skip:LOCATION_MISMATCH must actually be about geo; skip:NOT_A_MATCH about role type/level/domain. Wrong reason on a correct skip is a fail.
- **No fabrication**: The reason must not invent role attributes absent from the posting, or candidate facts absent from the context. Scan is given NO company-wide skip history — so ANY "prior skips confirm…", "N past closes", or "this company doesn't hire in X" claim is fabrication and a fail.

**SHOULD (warn flags):**
- **Bucket calibration**: STRONG = clear fit at the right level with no geo problem; an on-domain role that's a geo stretch for a relocation-open candidate is better as POSSIBLE/WEAK than STRONG. Burying a clear fit in WEAK is also a warn.
- **Reason quality**: One short, specific, user-facing sentence. Generic ("looks like a fit") or jargon/enum leakage ("SCANNED", "NOT_A_MATCH") is a warn.
- **Not over-skipping**: This is an ABSOLUTE call — skipping a genuine match because "a better one might exist" is wrong (that's the shortlist's job).

Anchor your rationale to the specific role + the candidate signal that justifies (or contradicts) the decision and bucket.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  const job = await prisma.job.findFirst({
    where: {
      rawContent: { not: null },
      company: { slug: fx.slug },
      title: { contains: fx.titleContains, mode: "insensitive" },
      ...(fx.locationContains
        ? {
            locationAndArrangement: {
              contains: fx.locationContains,
              mode: "insensitive" as const,
            },
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      ...ROLE_ATTR_SELECT,
      enrichedSummary: true,
      attributes: true,
      enrichedAttributes: true,
      rawContent: true,
      company: { select: { name: true, description: true } },
    },
    orderBy: { title: "asc" },
  });
  if (!job)
    throw new Error(
      `no job at ${fx.slug} matching "${fx.titleContains}" (loc ${fx.locationContains ?? "any"})`,
    );

  const p = fx.persona;
  const roleText = (job.enrichedSummary ?? job.rawContent ?? "").trim();
  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    `- **Injected candidate:** ${p.label}`,
    fx.expectDecision
      ? `- **Auditor's expected decision:** ${fx.expectDecision}${fx.expectCloseReason ? ` (${fx.expectCloseReason})` : ""}`
      : `- **Auditor's expected decision:** (borderline — no pin)`,
    "",
    `### Role: ${job.title} @ ${job.company?.name ?? fx.slug}`,
    `_${formatRoleAttrs(toRoleAttrs(job)) || "no metadata"}_`,
    "",
    "```",
    roleText.slice(0, 2500) +
      (roleText.length > 2500 ? "\n[...truncated]" : ""),
    "```",
    "",
    `### Injected candidate profile (profile.md)`,
    "```md\n" + p.profile + "\n```",
    "",
    `### Injected resume summary`,
    "```json\n" + p.resume.slice(0, 2000) + "\n```",
    "",
    `_(scan judges THIS role for THIS candidate only — it is given NO company-wide skip history; any "prior skips confirm…" / "company doesn't hire here" reasoning is fabrication.)_`,
  ].join("\n");

  // The REAL job still comes from the DB (its summary/location/comp) — only the
  // candidate side is the fixture's, so a pinned decision stays coherent with the
  // candidate it describes. Both now arrive as one plain `input`; there's no
  // bypass flag and nothing to dryRun, since the sub-agent doesn't persist.
  const result = await runSubAgent(
    scanJobSubAgent,
    {
      role: {
        title: job.title,
        companyName: job.company?.name ?? fx.slug,
        summary: roleText,
        ...toRoleAttrs(job),
        attributes: job.attributes,
        enrichedAttributes: job.enrichedAttributes,
      },
      profile: p.profile,
      resume: p.resume,
      // The company side comes from the real row (the job does too); only the
      // candidate is the fixture's.
      companyDescription: job.company?.description ?? null,
      companyNote: fx.companyNote ?? null,
      companyNotePath: `companies/${fx.slug}.md`,
      // No fixture exercises a role note yet — scan almost never sees one.
      jobNote: null,
      jobNotePath: null,
    },
    ctx,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  let actualDecision = "(none)";
  let actualCloseReason = "(n/a)";
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else if (result.output.decision === "skip") {
    actualDecision = "skip";
    actualCloseReason = result.output.closeReason;
    outputMarkdown = `**decision:** skip (${result.output.closeReason})\n\n**reason:** ${result.output.reason}`;
    outputSummary = `skip:${result.output.closeReason}`;
  } else {
    actualDecision = "match";
    outputMarkdown = `**decision:** match — bucket ${result.output.bucket}${result.output.score != null ? ` (score ${result.output.score})` : ""}\n\n**reason:** ${result.output.reason}`;
    outputSummary = `match:${result.output.bucket}`;
  }

  const expectedFields: Record<string, { equals: string; label: string }> = {};
  const actualFields: Record<string, string> = {};
  if (fx.expectDecision) {
    expectedFields.decision = {
      equals: fx.expectDecision,
      label: "expectedDecision",
    };
    actualFields.decision = actualDecision;
    if (fx.expectCloseReason) {
      expectedFields.closeReason = {
        equals: fx.expectCloseReason,
        label: "expectedCloseReason",
      };
      actualFields.closeReason = actualCloseReason;
    }
  }

  const judge = await runJudge({
    client: ctx.judgeClient,
    subAgentName: "scanJobSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
    ...(fx.expectDecision ? { expectedFields, actualFields } : {}),
  });

  return {
    subAgent: "scanJobSubAgent",
    caseName: fx.name,
    caseKind: fx.expectDecision ? "synthetic_adversarial" : "real",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `${p.label}; want=${fx.expectDecision ?? "(none)"}${fx.expectCloseReason ? `/${fx.expectCloseReason}` : ""}; role=${job.title.slice(0, 34)}`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "scanJobSubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) => `${f.name.padEnd(28)} ${f.persona.label}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
