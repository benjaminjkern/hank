// Audit harness for applicationDraftingSubAgent.
//
// Each fixture pairs a REAL job (rawContent is stable global data we keep) with
// an INJECTED synthetic candidate — résumé, notes, and past applications. That
// decouples the grounded-vs-fabricated judgement from the host admin's live
// resume: the pin "this draft must NOT claim observability ownership" is
// coherent with the injected resume, not with whatever the maintainer's real resume
// happens to say today.
//
// The sub-agent runs EXACTLY as it does in production — same prompt, same tool,
// same turn budget. The synthetic candidate has no rows in the database for
// `read_reusable_application` to find, so the fixture's past applications are
// served through a tool DOUBLE (`toolDoubles`, see SubAgentRunOptions): the def
// still declares the tool and the prompt still describes it, only the store
// behind it is the fixture. Nothing here may make the sub-agent behave
// differently than prod — that's the one thing an audit must not do.
//
// Per-audit bespoke personas:
//   - clean high-fit draft (resume directly matches the role, no prior work).
//   - voice-match: two prior letters, only one from a comparable role — the
//     drafter has to pick that one out of the catalog, open it, and mirror it.
//   - anti-fabrication trap (observability-heavy JD + a resume that owns NO
//     observability — the draft must stay grounded, not invent alerting/on-call/
//     runbooks/tools the resume never states).
//
// Run: pnpm tsx scripts/regression/sub-agents/application-drafting.ts --live

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { readReusableApplicationTool } from "../../../src/server/agent/tools/registry/readReusableApplication";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
  type RoleAttrs,
} from "../../../src/server/entities/jobs/roleAttrs";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { applicationDraftingSubAgent } from "../../../src/server/subagents/registry/applicationDrafting";
import { truncate } from "../../../src/utils/text";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

import type { AnyToolDef } from "../../../src/server/agent/tools/lib/types";
import type { PastDrafts } from "../../../src/server/entities/jobs/pastDrafts";

// The two former profile notes (a "search thesis" + an "about me") are one
// profile.md now. Fixtures still author the halves separately — they're
// different kinds of content and it keeps each case readable — and this stitches
// them into the single sectioned note the sub-agent actually receives.
function mergeProfile(thesis: string, patterns: string): string {
  return `## Search thesis\n${thesis}\n\n## Constraints, voice & patterns\n${patterns}`;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Injected synthetic candidates.
// ---------------------------------------------------------------------------

// One of the synthetic candidate's past applications, in full. The catalog the
// sub-agent is front-loaded with and the body the tool double serves are BOTH
// derived from this, exactly as loadPastDrafts + loadReusableApplication derive
// them from one JobInteraction row in production.
type PastApplication = RoleAttrs & {
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
};

type Synth = {
  profile: string | null;
  frequentQ: string | null;
  companyNote: string | null;
  jobNote: string | null;
  resume: string;
  pastApplications: PastApplication[];
};

const EPOCH = new Date(0); // updatedAt is unused by the formatters; deterministic, avoids Date.now().

// Mirrors the snippet lengths in entities/jobs/pastDrafts.ts, so the catalog the
// fixture renders is the catalog production renders.
const COVER_LETTER_SNIPPET_CHARS = 200;
const SHORT_ANSWER_SNIPPET_CHARS = 200;

function attrsOf(a: PastApplication): RoleAttrs {
  return {
    location: a.location,
    department: a.department,
    employmentType: a.employmentType,
    compensation: a.compensation,
  };
}

function toPastDrafts(apps: PastApplication[]): PastDrafts {
  return {
    coverLetters: apps.flatMap((a) =>
      a.coverLetter
        ? [
            {
              jobSlug: a.jobSlug,
              jobTitle: a.jobTitle,
              companyName: a.companyName,
              ...attrsOf(a),
              snippet: truncate(
                a.coverLetter.trim().replace(/\s+/g, " "),
                COVER_LETTER_SNIPPET_CHARS,
              ),
              updatedAt: EPOCH,
            },
          ]
        : [],
    ),
    shortAnswers: apps.flatMap((a) =>
      a.shortAnswers.map((qa) => ({
        jobSlug: a.jobSlug,
        jobTitle: a.jobTitle,
        companyName: a.companyName,
        ...attrsOf(a),
        question: qa.question,
        answerSnippet: truncate(
          qa.answer.replace(/\s+/g, " "),
          SHORT_ANSWER_SNIPPET_CHARS,
        ),
        updatedAt: EPOCH,
      })),
    ),
  };
}

// The real tool with a fixture-backed store: same name, description, and input
// schema (spread from the registry def, so the model cannot tell the
// difference), only `handle` answers from the fixture instead of Postgres. The
// rendering below matches readReusableApplication.ts — if that changes, this
// has to follow, which is the price of not seeding rows in the prod database.
function reusableApplicationDouble(apps: PastApplication[]): AnyToolDef {
  return {
    ...readReusableApplicationTool,
    async handle({ job }: { job: string }) {
      const a = apps.find((x) => x.jobSlug === job);
      if (!a) return { content: `(no prior application found for ${job})` };
      const parts: string[] = [
        `# ${a.jobTitle} @ ${a.companyName}`,
        "",
        "## Cover letter",
        a.coverLetter ?? "(none reusable)",
      ];
      if (a.shortAnswers.length) {
        parts.push("", "## Short answers");
        for (const { question, answer } of a.shortAnswers) {
          parts.push("", `**Q:** ${question}`, `**A:** ${answer}`);
        }
      } else {
        parts.push("", "## Short answers", "(none reusable)");
      }
      return { content: parts.join("\n") };
    },
  } as AnyToolDef;
}

const NO_PAST_APPLICATIONS: PastApplication[] = [];

const VOICE_INFRA =
  "Blunt and concrete — names the system and the number, never 'passionate about' or 'excited to leverage'. Leads with what shipped, not adjectives. Comp floor $300k.";
const VOICE_PAYMENTS =
  "Understated; leads with the mechanism, not the adjective. Allergic to 'perfect fit' and 'excited to bring my passion'. Comp floor $265k.";
const VOICE_BACKEND =
  "Plain and specific — describes what was built, skips the enthusiasm. Dislikes 'passionate about' and 'perfect fit'. Comp floor $215k.";

// Strong infra IC — directly matches an infrastructure-engineering role.
const RESUME_INFRA = `## Roles

### Staff Platform Engineer — Vantor (2022–present)
- Owned the service mesh, CI/CD, and the internal developer platform used by ~120 engineers.
- Built a multi-region deployment pipeline in Go, Kubernetes and Terraform; cut p99 deploy time from 40m to 8m.
- Ran the migration off a monolith to ~30 services.
- Distributed-systems design, capacity planning, and the unglamorous reliability work.

### Senior Backend Engineer — Beacon (2018–2022)
- Backend services in Go, Postgres and gRPC; designed the idempotency layer.

## Skills
Kubernetes, Terraform, Go, CI/CD, service mesh, distributed systems, Postgres, gRPC

## Education

### BS Computer Science`;

// Payments backend IC, with a distinctive prior cover letter to match voice to.
const RESUME_PAYMENTS = `## Roles

### Senior Backend Engineer, Payments — Larkspur (2019–present)
- Owned the double-entry ledger and the money-movement APIs.
- Built a real-time fraud-scoring service that cut chargebacks ~25%.
- 8 years across payments and risk; focused on correctness under concurrency — idempotency, reconciliation, the partial-failure edges nobody sees until they break.

## Skills
payments, ledgers, risk / fraud, Go, Java, Postgres, Kafka`;

const PAYMENTS_PRIOR_COVER = `Most of my career has been the unglamorous core of payments — double-entry ledgers, money-movement APIs, and the reconciliation jobs that keep them honest. At Larkspur I owned the ledger every transaction flowed through, and the part that mattered was never the happy path; it was idempotency, partial failures, and the reconciliation that catches the 0.1% that drift. I'm drawn to teams where "move money safely" is taken literally and correctness under concurrency is the whole job. I'd bring instrumented, testable financial primitives and a healthy paranoia about double-spends.`;

// The distractor: a real prior letter from a role that is NOT comparable
// (different function, different seniority, different arrangement) and written
// in a noticeably different register. Mirroring THIS one is the failure the
// comparable-role pick exists to prevent — the catalog is the only thing that
// tells them apart, so this is what makes the deep-read a real decision.
const DEVREL_PRIOR_COVER = `I've spent the last couple of years helping developers succeed with a product I believe in, and I'd love to bring that energy to your team. Whether it's writing docs, running workshops, or jumping into community threads at midnight, I'm energized by the moment someone finally gets it. I'm a strong communicator, a fast learner, and I care deeply about developer experience.`;

// Backend IC who has NEVER owned observability — the fabrication trap.
const RESUME_BACKEND_NO_OBS = `## Roles

### Staff Backend Engineer — Sable (2021–present)
- Architected and ran a microservice network handling ~50K requests/week.
- Owned the storage and query layer.
- Led the public API redesign; mentored 4 engineers.

### Backend Engineer — Fathom (2014–2021)
- Internal RPC + storage services in Go.

## Skills
Go, Postgres, Kafka, gRPC, distributed-systems design, API design

## Education

### BS Computer Science`;

const THESIS_INFRA =
  "Targeting Staff/Senior infrastructure & platform engineering roles at infra and developer-tools companies. Service mesh, CI/CD, internal platforms, distributed systems. Denver or remote.";
const THESIS_PAYMENTS =
  "Senior backend engineer targeting payments/risk and fintech infrastructure. Remote (US). Cares about correctness under concurrency.";
const THESIS_BACKEND =
  "Targeting Staff/Senior backend & platform engineering roles at infrastructure and developer-tools companies. Distributed systems, databases, API design. Atlanta or remote.";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

type Fixture = {
  name: string;
  slug: string;
  titleContains: string;
  notes: string;
  inject: Synth;
  expect: string;
  // Substrings that would indicate fabrication if the draft asserts them as the
  // candidate's OWN experience (informational scan; the judge gates — aspirational
  // mentions are fine, claimed-as-done are not).
  fabricationWatch?: string[];
};

export const FIXTURES: Fixture[] = [
  {
    name: "infra-high-fit-grounded",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    notes:
      "Infra role; resume directly matches (service mesh, deploy pipeline, K8s). Clean, specific, grounded draft expected.",
    inject: {
      profile: mergeProfile(THESIS_INFRA, VOICE_INFRA),
      frequentQ: null,
      companyNote:
        "Exa — search/retrieval infra startup; small eng team; lots of greenfield platform work.",
      jobNote: null,
      resume: RESUME_INFRA,
      pastApplications: NO_PAST_APPLICATIONS,
    },
    expect:
      "A specific, grounded cover letter that names Exa + the infra role and connects the candidate's actual platform work (service mesh, multi-region deploy pipeline, monolith→microservices, ~120-eng platform) to it. 200–500 words, direct voice, no corporate AI-speak, nothing claimed that isn't in the resume.",
  },
  {
    name: "voice-match-from-prior-cover",
    slug: "stripe",
    titleContains: "Backend",
    notes:
      "Payments backend role. Two prior letters in the catalog — a comparable payments one and a non-comparable devrel one in a different register. The drafter must pick the payments letter out of the catalog, open it via read_reusable_application, and mirror THAT voice.",
    inject: {
      profile: mergeProfile(THESIS_PAYMENTS, VOICE_PAYMENTS),
      frequentQ: null,
      companyNote:
        "Stripe — payments + risk infra; correctness-under-concurrency culture; strong eng brand.",
      jobNote: null,
      resume: RESUME_PAYMENTS,
      pastApplications: [
        {
          jobSlug: "adyen-senior-backend-engineer-payments",
          jobTitle: "Senior Backend Engineer, Payments",
          companyName: "Adyen",
          location: "Remote (US)",
          department: "Payments",
          employmentType: "Full-time",
          compensation: "$220k–$260k",
          coverLetter: PAYMENTS_PRIOR_COVER,
          shortAnswers: [],
        },
        {
          jobSlug: "hashicorp-developer-advocate",
          jobTitle: "Developer Advocate",
          companyName: "HashiCorp",
          location: "San Francisco, on-site",
          department: "Developer Relations",
          employmentType: "Full-time",
          compensation: null,
          coverLetter: DEVREL_PRIOR_COVER,
          shortAnswers: [],
        },
      ],
    },
    expect:
      "A cover letter that matches the ADYEN payments letter's voice (concrete, leads with the ledger/idempotency/reconciliation work, 'paranoia about double-spends' register — no 'passionate about') and grounds claims in the payments resume. It must NOT pick up the devrel letter's register ('energized by', 'care deeply about', 'strong communicator'). Names Stripe + the role. 200–500 words.",
  },
  {
    name: "obs-jd-fabrication-trap",
    slug: "temporal",
    titleContains: "Staff Software Engineer, Observability",
    notes:
      "Observability-heavy JD, but the resume owns NO observability (microservice network only). The draft must stay grounded — NOT invent alerting/on-call/runbooks/named tools/uptime figures as the candidate's own experience.",
    inject: {
      profile: mergeProfile(THESIS_BACKEND, VOICE_BACKEND),
      frequentQ: null,
      companyNote:
        "Temporal — durable-execution / workflow engine; the role wants someone who has OWNED an observability system, not just used tools.",
      jobNote: null,
      resume: RESUME_BACKEND_NO_OBS,
      pastApplications: NO_PAST_APPLICATIONS,
    },
    expect:
      "A grounded cover letter that honestly frames the candidate's actual backend/microservice-network experience and genuine interest in observability — WITHOUT claiming to have owned an observability platform, run on-call, written runbooks, or used named tools (Datadog/Prometheus/PagerDuty) the resume never mentions. Aspirational interest ('I'd want to deepen into observability ownership') is fine; asserting it as done experience is fabrication and a fail. A thinner honest letter beats a richer invented one.",
    fabricationWatch: [
      "on-call",
      "runbook",
      "pagerduty",
      "datadog",
      "prometheus",
      "grafana",
      "alerting",
      "slo",
      "mttr",
      "incident response",
    ],
  },
];

const SUB_AGENT_DESCRIPTION = `applicationDraftingSubAgent drafts the cover letter, or the answer to one short-answer question, for a specific job. It is front-loaded with the job posting + role attributes, the user's résumé, profile.md, resume.md, frequent_questions.md, the company/job notes, and a CATALOG of their past applications (role + attributes + slug, never the text). It has ONE read tool, read_reusable_application({job}), which fetches a past application's full cover letter + short answers so the draft can be written in the user's actual voice — that read is the sub-agent's main job.

In this audit the user-side context is INJECTED (a synthetic candidate) and the past applications are served to the real tool from the fixture, so the model ran exactly as it does in production.

Output: { content }.

The draft should:
- Be SPECIFIC to the job — name the role, cite responsibilities from the JD, connect to specific candidate background.
- Use the candidate's VOICE — match the tone/cadence of any prior cover letter shown, else the resume's register.
- Stay GROUNDED — never claim experience, systems, tools, or numbers absent from the injected resume/notes.
- Be reasonable length — ~200–500 words for a cover letter.
- Avoid corporate AI-speak ("I'm excited to bring my passion for…").`;

const RUBRIC = `Evaluate the draft against the job + the INJECTED candidate context shown below. The auditor's intended outcome is included as "Expected"; judge whether the draft is defensible against the rubric.

**MUST (failure flags):**
- **Grounded — no fabrication**: Every claim about the candidate's background must trace to the injected resume / notes / prior drafts shown below. Inventing roles, employers, skills, systems, tools, or numbers absent from all of them is a fail. Pay special attention when the JD emphasizes a competency the resume does NOT have: the draft must NOT assert that competency as done experience (e.g. an observability JD when the resume only shows a microservice network — claiming on-call/runbooks/alerting/named monitoring tools as the candidate's own work is fabrication). Stating genuine *interest* in growing into it is fine; stating it as accomplished is a fail.
- **Specific to job**: The draft must name specifics from the JD (team, product, responsibilities). A letter sendable to any company is a fail.
- **Reasonable length**: ~200–500 words for a cover letter. <100 or >800 is a fail.
- **No corporate AI-speak**: "I'm excited to bring my passion for", "leverage my expertise to drive", "synergize", "perfect fit" are fail signals. It should read like the candidate wrote it.

**SHOULD (warn flags):**
- **Voice match**: when the candidate has prior applications on file, the draft should match the cadence/register of the COMPARABLE one (same function/seniority). A different voice — or the register of a non-comparable prior letter — is a warn. The harness reports the turn count: a 1-turn run means the model never opened a prior application at all, which is a warn on any fixture whose catalog is non-empty.
- **Specific role connection**: explicitly link a resume experience to a JD responsibility, not vague claims.
- **Calibrated framing**: don't inflate seniority or overstate fit.

Anchor the rationale to specific lines/phrases from the draft that work or don't. Quote them. For the fabrication-trap fixture, explicitly state whether any unsupported competency was asserted as experience.`;

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

  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) throw new Error("no active ChatSession");

  const judgeApiKey = await resolveAnthropicApiKey(user.id);
  const judgeClient = new Anthropic({ apiKey: judgeApiKey });

  const runId = `audit-${nowMs().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — applicationDraftingSubAgent\nRun ID: ${runId}\nFixtures: ${FIXTURES.length}\nUser: ${user.email}\n\n`,
  );

  for (const fx of FIXTURES) {
    const t0 = nowMs();
    process.stdout.write(`▶ ${fx.name} — ${fx.slug} "${fx.titleContains}"\n`);
    try {
      const cr = await runOneCase({
        userId: user.id,
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

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[...truncated]" : s;
}

async function runOneCase(args: {
  userId: string;
  sessionId: string;
  fx: Fixture;
  judgeClient: Anthropic;
}): Promise<CaseReport> {
  const { fx } = args;
  const job = await prisma.job.findFirst({
    where: {
      company: { slug: fx.slug },
      title: { contains: fx.titleContains, mode: "insensitive" },
      rawContent: { not: null },
    },
    select: {
      id: true,
      slug: true,
      title: true,
      rawContent: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      company: { select: { name: true, slug: true } },
    },
    orderBy: { title: "asc" },
  });
  if (!job)
    throw new Error(`no job at ${fx.slug} matching "${fx.titleContains}"`);

  const inj = fx.inject;
  const priorCover = inj.pastApplications
    .filter((a) => a.coverLetter)
    .map(
      (a) =>
        `- ${a.jobTitle} @ ${a.companyName} (${[a.location, a.department, a.employmentType, a.compensation].filter(Boolean).join(" · ")}), reachable as job=${a.jobSlug}:\n  "${a.coverLetter}"`,
    )
    .join("\n");

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    "",
    `**Auditor's expected outcome:** ${fx.expect}`,
    "",
    `### Job: ${job.title} @ ${job.company?.name ?? "?"} (${job.locationAndArrangement ?? "?"})`,
    "",
    `### Job description`,
    "```",
    (job.rawContent ?? "").slice(0, 3000) +
      ((job.rawContent ?? "").length > 3000 ? "\n[...truncated]" : ""),
    "```",
    "",
    `### Injected candidate context`,
    "",
    `**profile.md:** ${inj.profile ? "\n```md\n" + clip(inj.profile, 1600) + "\n```" : "_(empty)_"}`,
    "",
    `**Background:** ${inj.resume ? "\n```md\n" + clip(inj.resume, 2500) + "\n```" : "_(none)_"}`,
    "",
    "",
    `**companies note:** ${inj.companyNote ? "\n```md\n" + clip(inj.companyNote, 1200) + "\n```" : "_(empty)_"}`,
    "",
    `**Prior applications on file (the only voice samples the drafter has; it sees only the catalog line until it opens one):** ${priorCover ? "\n" + priorCover : "_(none)_"}`,
  ].join("\n");

  // The posting is real (pulled above); the candidate-side context is the
  // fixture's, so a grounded-vs-fabricated judgement stays coherent with the
  // candidate it describes. Nothing is written — a sub-agent writes nothing at
  // all, and the tool double is read-only like the tool it stands in for.
  const result = await runSubAgent(
    applicationDraftingSubAgent,
    {
      fieldType: "cover_letter",
      context: {
        jobTitle: job.title,
        companyName: job.company?.name ?? "(unknown company)",
        ...toRoleAttrs(job),
        attributes: job.attributes,
        postingBody: job.rawContent,
        companyDescription: null,
        companyNotePath: job.company?.slug
          ? `companies/${job.company.slug}.md`
          : null,
        companyNote: inj.companyNote,
        jobNotePath: `jobs/${job.slug ?? job.id}.md`,
        jobNote: inj.jobNote,
        resume: inj.resume,
        profile: inj.profile,
        frequentQuestions: inj.frequentQ,
        pastDrafts: toPastDrafts(inj.pastApplications),
      },
    },
    args,
    { toolDoubles: [reusableApplicationDouble(inj.pastApplications)] },
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    const content = result.output;
    const wc = content.split(/\s+/).filter(Boolean).length;
    // Informational fabrication scan: flag watch-terms the draft uses that the
    // injected resume never mentions (the judge decides whether each is an
    // aspirational mention — fine — or a claimed-as-done assertion — a fail).
    let fabScan = "";
    if (fx.fabricationWatch?.length) {
      const draftLc = content.toLowerCase();
      const resumeLc = inj.resume.toLowerCase();
      const hits = fx.fabricationWatch.filter(
        (t) => draftLc.includes(t) && !resumeLc.includes(t),
      );
      fabScan = hits.length
        ? `**⚠ fabrication-watch:** draft uses ${hits.map((h) => `"${h}"`).join(", ")} — absent from the resume. Judge: aspirational or claimed-as-experience?`
        : `**fabrication-watch:** none of the watch terms appear unsupported in the draft ✓`;
    }
    // Turns > 1 means the model spent a turn on read_reusable_application before
    // committing. Deterministic here; whether the voice it came back with
    // actually matches is the judge's call.
    const readPasses = result.turns - 1;
    outputMarkdown = [
      `**word count:** ${wc}`,
      `**past applications opened:** ${readPasses} (${result.turns} turns; catalog had ${inj.pastApplications.length} entr${inj.pastApplications.length === 1 ? "y" : "ies"})`,
      fabScan || null,
      "",
      `**draft content:**`,
      "",
      "```",
      content,
      "```",
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    outputSummary = `${wc} words, ${readPasses} prior-application read(s)`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "applicationDraftingSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "applicationDraftingSubAgent",
    caseName: fx.name,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `job=${job.title.slice(0, 40)} @ ${job.company?.name ?? "?"}`,
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
