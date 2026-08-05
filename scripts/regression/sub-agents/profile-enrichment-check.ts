// Audit harness for profileEnrichmentCheckSubAgent.
//
// This sub-agent has a deterministic pre-gate that short-circuits the LLM when
// both load-bearing slots are obviously full — so real users either bypass the
// LLM (rich profiles) or trivially fail it (cold start). The interesting
// judgement (short-but-maybe-ok, long-but-vague) lives on a boundary no real
// user happens to sit on. So every fixture here IS a synthetic ProfileInventory
// — the sub-agent takes one as its argument, and the pre-gate lives on the other
// side of that boundary (entities/profile/profileInventory.ts), so a fixture
// reaches the LLM path without anything to bypass.
//
// The run is hermetic by construction, not by a harness flag: the sub-agent has
// no read tools and is shown both slots in full, so the harness exercises
// exactly the call prod makes and the judge grades exactly what the model saw.
//
// The verdict's discrete `ok` is recorded mechanically against each fixture's
// expectation; the LLM judge runs on every case to also grade the missing[]
// labels + probe quality on the ok=false path.

import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { profileEnrichmentCheckSubAgent } from "../../../src/server/subagents/registry/profileEnrichmentCheck";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";
import type { ProfileInventory } from "../../../src/server/entities/profile/profileInventory";

type Inventory = ProfileInventory;

type Fixture = {
  name: string;
  notes: string;
  expectOk: boolean;
  inv: Inventory;
};

const RICH_PROFILE = `## Search thesis
Targeting Senior/Staff machine-learning engineering roles at applied-ML and recommendations companies, Series B through public. Strong on model-serving infrastructure, feature pipelines, and ranking systems. Hybrid in Austin or remote. Comp floor ~$275k total comp. Avoiding pure-research labs, adtech, and seed-stage single-product startups. Motivation: wants to own an end-to-end ML platform, not hand models over a wall.

## Constraints
Comp floor $275k. Location: remote or Austin hybrid. Skips sub-Senior roles and single-product seed startups.

## What I care about
A real ML-platform org, offline/online parity, sane on-call. Avoids: adtech, crypto, pure research with no production path.

## Voice
Warm but exact; explains the tradeoff, names the metric.`;
const RICH_RESUME_NOTES =
  "10y in ML/data; last 4 as Staff ML Engineer at a Series D recommendations company owning the model-serving + feature-pipeline stack (Python, PyTorch, Ray, Feast). Before that ML platform at two startups. CS degree, focus in ML. Led a 5-person ML-platform team. Comfortable with ranking systems, offline/online parity, and latency-sensitive inference.";

export const FIXTURES: Fixture[] = [
  {
    name: "rich-complete",
    notes:
      "both slots substantive and specific → enriched (LLM should agree with the would-be pre-gate)",
    expectOk: true,
    inv: { profile: RICH_PROFILE, resume: RICH_RESUME_NOTES },
  },
  {
    name: "tight-but-substantive",
    notes:
      "short slots that are nonetheless specific → enriched (substantive ≠ long)",
    expectOk: true,
    inv: {
      profile:
        "Senior security engineer, product-security and appsec at SaaS companies, remote or Boston, comp floor $205k, avoid pure-compliance and consultancies. Threat-model-first, writes terse tickets. Skips sub-Senior and GRC-only roles.",
      resume:
        "8y security, last 3 as Staff Product Security Engineer at a fintech (threat modeling, SAST/DAST, secure SDLC). CS degree.",
    },
  },
  {
    name: "shallow-profile",
    notes:
      "one-line generic profile, background present → NOT enriched (too thin to drive matching)",
    expectOk: false,
    inv: {
      profile: "I want a software engineering job.",
      resume: RICH_RESUME_NOTES,
    },
  },
  {
    name: "background-only-no-profile",
    notes: "background notes present but no profile at all → NOT enriched",
    expectOk: false,
    inv: {
      profile: null,
      resume:
        "Resume parsed: 9y mobile engineer (iOS/Swift), two consumer startups.",
    },
  },
  {
    name: "generic-filler-profile",
    notes:
      "profile is long but vague boilerplate (no role/level/comp/location signal) → NOT enriched",
    expectOk: false,
    inv: {
      profile:
        "I'm passionate about technology and building impactful products. I want to grow my career at an innovative company with a great culture and smart people, where I can make a real difference and keep learning. Mission-driven teams excite me and I value work-life balance. Likes nice culture. Wants growth.",
      resume: "Some engineering background.",
    },
  },
  {
    name: "specific-thesis-no-background",
    notes:
      "sharp thesis but resume.md never populated → NOT enriched (drafting has nothing to work from)",
    expectOk: false,
    inv: {
      profile:
        "Staff-level frontend / design-systems roles at product companies with a serious design bar. Remote or Portland. Comp floor $195k. Avoids agencies and marketing-site shops. Opinionated about accessibility and component-API design.",
      resume: null,
    },
  },
  {
    name: "cold-start",
    notes: "both slots empty → NOT enriched",
    expectOk: false,
    inv: { profile: null, resume: null },
  },
];

const SUB_AGENT_DESCRIPTION = `profileEnrichmentCheckSubAgent is rung-0's gatekeeper: it is shown the full contents of the user's two load-bearing memory slots and decides whether what's written there is substantive enough to leave profile-enhancement mode and start matching jobs. Output: { enriched: true } OR { enriched: false, missing: string[], suggestedProbes: string[] }.

The two slots are profile.md (search thesis + constraints + voice + patterns) and resume.md (Hank's notes on the user's background, from an upload OR the user's own chat breakdown). It judges SUBSTANCE only — slot lengths, whether a resume file was uploaded, and how many other notes exist are settled deterministically by a pre-gate on the other side of the boundary and are deliberately never shown to it, so a verdict that leans on any of them (especially treating a missing resume upload as a gap) is wrong by construction. ok=true ONLY when both slots are specific to THIS user (role type, level, domain, comp/location constraints; real roles, scope, technologies) — "substantive" means specific, not long. When ok=false, the missing[] labels and suggestedProbes guide the enrich-profile agent on what to elicit next; probes must be short, user-facing, plain English (no enum codes / path references). When in doubt the gate should lean ok=false (one more question is cheap; bad downstream output is expensive).`;

const RUBRIC = `Evaluate the gate verdict against the injected slot contents.

**MUST (failure flags):**
- **Decision correctness**: ok=true requires a profile that is genuinely specific (role type + level + at least one of comp/location/domain) AND background notes that name real roles/scope. An empty slot, a one-line profile, or vague boilerplate must yield ok=false. Calling a thin/generic profile "enriched" is a fail; gating a clearly-rich-and-specific profile as not-enriched is also a fail.
- **No fabricated gaps**: missing[] labels must reflect what's actually thin in the slots shown, not invented ones — and never a resume-file upload, which the sub-agent is not shown and must not gate on.

**SHOULD (warn flags):**
- **Targeted missing[]**: on ok=false, the labels should name the real weak slots ('thesis', 'comp_floor', 'background', etc.), not a generic catch-all.
- **Probe quality**: suggestedProbes should be 2-3 short, natural, user-facing questions that would actually elicit the missing signal — no system jargon, no enum/path references.
- **Substantive ≠ long calibration**: a short-but-specific profile should pass; a long-but-vague profile should fail. Mis-calling either direction on calibration is a warn (fail only if egregious).

The fixture's intended verdict is provided to you below as the auditor's expectation. Judge whether the sub-agent's actual verdict + reasoning are defensible; a defensible disagreement with the expectation can still be a pass if the rubric supports it, but flag it.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  const slot = (label: string, v: string | null) =>
    `**${label}:** ${v ? "\n```\n" + v + "\n```" : "_(empty)_"}`;

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    `- **Auditor's expected verdict:** ok=${fx.expectOk}`,
    "",
    "### Injected slot contents (all the sub-agent is shown)",
    slot("profile.md (thesis + constraints + voice)", fx.inv.profile),
    "",
    slot("resume.md (the user's background)", fx.inv.resume),
  ].join("\n");

  const run = await runSubAgent(
    profileEnrichmentCheckSubAgent,
    { inventory: fx.inv },
    ctx,
  );
  if (!run.ok) throw new Error(run.error);
  const result = run.output;

  const okMatched = result.enriched === fx.expectOk;
  let outputMarkdown: string;
  let outputSummary: string;
  if (result.enriched) {
    outputMarkdown = `**Verdict:** ok=true (profile is enriched enough)`;
    outputSummary = `ok=true (expected ${fx.expectOk}) ${okMatched ? "✓" : "✗ MISMATCH"}`;
  } else {
    outputMarkdown = [
      `**Verdict:** ok=false`,
      "",
      `**missing:** ${result.missing.length ? result.missing.join(", ") : "_(none)_"}`,
      "",
      `**suggestedProbes:**`,
      ...(result.suggestedProbes.length
        ? result.suggestedProbes.map((p) => `- ${p}`)
        : ["_(none)_"]),
    ].join("\n");
    outputSummary = `ok=false (expected ${fx.expectOk}) ${okMatched ? "✓" : "✗ MISMATCH"}, ${result.missing.length} missing`;
  }

  const judge = await runJudge({
    client: ctx.judgeClient,
    subAgentName: "profileEnrichmentCheckSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "profileEnrichmentCheckSubAgent",
    caseName: fx.name,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `expectOk=${fx.expectOk}, okMatched=${okMatched}`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "profileEnrichmentCheckSubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) => `${f.name.padEnd(24)} ${f.notes}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
