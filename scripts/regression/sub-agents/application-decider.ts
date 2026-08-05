// Audit harness for applicationDeciderSubAgent.
//
// Each fixture pairs a REAL job (its application form is stable global data we
// keep) with an INJECTED synthetic candidate context (resume /
// thesis / patterns / notes / past drafts) handed to the sub-agent as plain
// input. That decouples the graded verdicts from any live memory — the pin
// "this question → ask_user" is coherent with the candidate the fixture
// describes, not with whatever a stored resume currently says. The decider
// reads only the input it's handed, so the model decides from exactly the
// context shown (prior bodies are inlined in full in pastDrafts since the
// deep-read tool is off).
//
// Per-audit bespoke personas covering the decider's load-bearing calls:
//   - adjacency ≠ support (the observability regression): same job, two resumes
//     (one lacking observability → ask_user, one owning it → draft).
//   - stock/identity discipline (Stripe all-stock form → every question skip).
//   - reuse honored (a relevant prior answer flips ask_user → draft).
//   - help-first on a SOFT hold (cover letter is helped + a notice surfaced,
//     never silently skipped).
//
// Run: pnpm tsx scripts/regression/sub-agents/application-decider.ts --live
// (--live required because DATABASE_URL points at the Railway prod DB; the run
// is read-only — the sub-agent writes nothing and the harness never persists.)

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
  type RoleAttrColumns,
} from "../../../src/server/entities/jobs/roleAttrs";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { partitionApplicationForm } from "../../../src/server/procedures/registry/draftApplication/loadApplicationDeciderInput";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import {
  applicationDeciderSubAgent,
  type DraftVerdict,
} from "../../../src/server/subagents/registry/applicationDecider";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

import type {
  PastDrafts,
  PastCoverLetterEntry,
  PastShortAnswerEntry,
} from "../../../src/server/entities/jobs/pastDrafts";
import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
} from "../../../src/server/scrape/types";

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
// Synthetic candidate context (injected as the sub-agent's plain input).
// ---------------------------------------------------------------------------

type Synth = {
  profile: string | null;
  frequentQ: string | null;
  companyNote: string | null;
  jobNote: string | null;
  resume: string;
  memoryPaths: string[];
  pastDrafts: PastDrafts;
};

const EPOCH = new Date(0); // updatedAt is unused by the index formatters; keep it deterministic (no Date.now()).

// Role attributes are unused by these fixtures (comparability is judged from
// title + company here); null them out to satisfy the enriched entry type.
const NO_ATTRS = {
  location: null,
  department: null,
  employmentType: null,
  compensation: null,
};
function coverEntry(
  jobTitle: string,
  companyName: string,
  body: string,
): PastCoverLetterEntry {
  return {
    jobSlug: `synthetic-cl-${companyName}`,
    jobTitle,
    companyName,
    ...NO_ATTRS,
    snippet: body,
    updatedAt: EPOCH,
  };
}
function shortAnswerEntry(
  jobTitle: string,
  companyName: string,
  question: string,
  answer: string,
): PastShortAnswerEntry {
  return {
    jobSlug: `synthetic-sa-${companyName}`,
    jobTitle,
    companyName,
    ...NO_ATTRS,
    question,
    answerSnippet: answer,
    updatedAt: EPOCH,
  };
}
const NO_DRAFTS: PastDrafts = { coverLetters: [], shortAnswers: [] };

// Backend IC with NO observability ownership — adjacency only.
const RESUME_BACKEND_NO_OBS = `## Roles

### Staff Backend Engineer — Northwind (2021–present)
- Owned the storage and query layer for a ~50K req/wk microservice network.
- Led the public API redesign; mentored 4 engineers.

### Senior Backend Engineer — Meridian (2018–2021)
- Built the internal service-to-service RPC framework in Go; designed the retry/idempotency layer.

## Skills
Go, Postgres, Kafka, gRPC, distributed systems, API design`;

// SAME candidate but the background DIRECTLY evidences observability ownership.
const RESUME_BACKEND_OWNS_OBS = `## Roles

### Staff Backend / Observability Engineer — Northwind (2021–present)
- Owned the observability platform end to end: instrumented services with Prometheus, Grafana and OpenTelemetry.
- Built SLO-based alerting on latency, queue-depth and error-rate.
- Ran the on-call rotation and authored the incident runbooks; cut MTTR ~40%.
- Also ran the storage/query layer for a ~50K req/wk microservice network.

### Senior Backend Engineer — Meridian (2018–2021)
- Built the internal service-to-service RPC framework in Go; designed the retry/idempotency layer.

## Skills
observability, Prometheus, Grafana, OpenTelemetry, on-call / incident response, Go, Postgres, Kafka`;

// Fintech/payments backend IC — for the Stripe all-stock + cover-letter reuse case.
const RESUME_PAYMENTS = `## Roles

### Senior Backend Engineer, Payments — Halcyon (2019–present)
- Owned the double-entry ledger and the money-movement APIs.
- Built a real-time fraud-scoring service that cut chargebacks ~25%.
- 8 years across payments and risk.

## Skills
payments, ledgers, risk / fraud, Go, Java, Postgres, Kafka`;

const PAYMENTS_PRIOR_COVER = `I've spent the last six years building the unglamorous core of payments systems — double-entry ledgers, money-movement APIs, and the reconciliation jobs that keep them honest. At Halcyon I owned the ledger that every transaction flowed through; the work that mattered wasn't the happy path but the partial-failure and idempotency edges. I'm drawn to teams where correctness under concurrency is the whole job, and where "move money safely" is taken literally. I'd bring a bias toward instrumented, testable financial primitives and a healthy paranoia about double-spends.`;

const THESIS_BACKEND =
  "Targeting Staff/Senior backend & platform engineering roles at infrastructure and developer-tools companies. Distributed systems, databases, API design. Seattle or remote.";
const THESIS_PAYMENTS =
  "Senior backend engineer targeting payments/risk and fintech infrastructure. Chicago or remote. Cares about correctness under concurrency.";

const VOICE_BACKEND =
  "Plain, concrete voice — leads with the system built and the numbers, cuts the adjectives. Comp floor $245k.";
const VOICE_PAYMENTS =
  "Understated and precise — explains the mechanism, not the ambition. Comp floor $285k.";

// ---------------------------------------------------------------------------
// Fixtures: real job + injected persona + expected verdict pattern.
// ---------------------------------------------------------------------------

type Pin = { contains: string; verdict: DraftVerdict; why: string };

type Fixture = {
  name: string;
  notes: string;
  // Real job resolution: by exact id (regression pin) OR slug + titleContains.
  jobId?: string;
  slug?: string;
  titleContains?: string;
  inject: Synth;
  // Human-readable expectation shown to the judge as the auditor's intent.
  expect: string;
  // Mechanical key-question checks (matched case-insensitively on question text).
  pins?: Pin[];
  // Expected cover-letter verdict ("not_skip" = help-first: anything but skip).
  coverLetterExpect?: DraftVerdict | "not_skip" | "none";
  expectNotice?: boolean;
};

// A few fixtures below resolve a real posting from YOUR database by id (the rest
// are fully self-contained via `inject`). Point these at job ids from your own
// DB to exercise those cases; left unset, the harness skips them (job not found).
const OBS_JOB_ID = process.env.DECIDER_OBS_JOB_ID ?? "";
const REDDIT_JOB_ID = process.env.DECIDER_REDDIT_JOB_ID ?? "";

export const FIXTURES: Fixture[] = [
  {
    name: "obs-gap-adjacency-not-support",
    notes:
      "Observability role; candidate ran a microservice network but never OWNED observability. Adjacency ≠ support → the 'have you owned an observability system?' question must be ask_user, not draft.",
    jobId: OBS_JOB_ID,
    inject: {
      profile: mergeProfile(THESIS_BACKEND, VOICE_BACKEND),
      frequentQ: null,
      companyNote: null,
      jobNote: null,
      resume: RESUME_BACKEND_NO_OBS,
      memoryPaths: ["profile.md"],
      pastDrafts: NO_DRAFTS,
    },
    expect:
      "The 'owned/supported an Observability system' question → ask_user (resume shows a microservice network but NOT observability ownership — alerting/on-call/runbooks are absent; drafting would force invention). The coding-vs-operations split → ask_user (personal current split, not on the resume). Identity/logistics String fields (Phone, LinkedIn Profile, Website, 'where is your specific working location') → skip. Cover letter → ask_user or draft both defensible (no prior cover letter; some material in the posting).",
    pins: [
      {
        contains: "owned or supported an Observability",
        verdict: "ask_user",
        why: "adjacency≠support — resume lacks observability ownership",
      },
      { contains: "LinkedIn Profile", verdict: "skip", why: "identity URL" },
      {
        contains: "specific working location",
        verdict: "skip",
        why: "logistics the user fills in",
      },
    ],
  },
  {
    name: "obs-supported-direct-evidence",
    notes:
      "SAME observability role, but the resume DIRECTLY evidences owning an observability platform (OTel, SLO alerting, on-call, runbooks, MTTR). The same question should now be draft — proving the line is drawn on evidence, not on how hard the question sounds.",
    jobId: OBS_JOB_ID,
    inject: {
      profile: mergeProfile(THESIS_BACKEND, VOICE_BACKEND),
      frequentQ: null,
      companyNote: null,
      jobNote: null,
      resume: RESUME_BACKEND_OWNS_OBS,
      memoryPaths: ["profile.md"],
      pastDrafts: NO_DRAFTS,
    },
    expect:
      "The 'owned/supported an Observability system' question → draft (resume gives the concrete particulars: OTel instrumentation, SLO alerting on latency/queue-depth, on-call rotation, runbooks, ~40% MTTR cut). Identity String fields → skip. The coding-vs-ops split → ask_user (still personal/current, not stated).",
    pins: [
      {
        contains: "owned or supported an Observability",
        verdict: "draft",
        why: "resume directly evidences observability ownership",
      },
      { contains: "LinkedIn Profile", verdict: "skip", why: "identity URL" },
    ],
  },
  {
    name: "stripe-all-stock-plus-reuse-cover",
    notes:
      "Stripe Backend (Payments & Risk): every form question is identity/logistics/stock text (country, city, work-auth, sponsorship, years, employer, title, degree, school, WhatsApp opt-in). All must skip. A strong prior payments cover letter is on file → cover letter should draft (adapt the prior), not ask_user.",
    slug: "stripe",
    titleContains: "Backend Engineer, Payments and Risk",
    inject: {
      profile: mergeProfile(THESIS_PAYMENTS, VOICE_PAYMENTS),
      frequentQ: null,
      companyNote:
        "Stripe — payments + risk infra; correctness-under-concurrency culture; strong eng brand.",
      jobNote: null,
      resume: RESUME_PAYMENTS,
      memoryPaths: ["profile.md", "companies/stripe.md"],
      pastDrafts: {
        coverLetters: [
          coverEntry(
            "Senior Backend Engineer, Payments",
            "Adyen",
            PAYMENTS_PRIOR_COVER,
          ),
        ],
        shortAnswers: [],
      },
    },
    expect:
      "Every listed question is identity/logistics/stock (country, city/state, work-auth, sponsorship, years of experience, prior employer/title, degree, school, WhatsApp opt-in) → all skip. Cover letter → draft (a strong prior payments cover letter for a comparable role is on file to adapt; resume + company note give real material).",
    pins: [
      {
        contains: "years of experience",
        verdict: "skip",
        why: "stock factual field",
      },
      {
        contains: "most recent degree",
        verdict: "skip",
        why: "stock identity field",
      },
      {
        contains: "current or previous employer",
        verdict: "skip",
        why: "stock identity field",
      },
    ],
    coverLetterExpect: "draft",
  },
  {
    name: "reuse-flips-why-to-draft",
    notes:
      "Block Senior SWE, Product Platform: the open 'why are you applying / what excites you' prose question has a near-identical prior short answer on file → must be draft (adapt the prior), not ask_user. Identity fields still skip.",
    slug: "block",
    titleContains: "Senior Software Engineer, Product Platform",
    inject: {
      profile: mergeProfile(THESIS_PAYMENTS, VOICE_PAYMENTS),
      frequentQ: null,
      companyNote:
        "Block (Square/Cash App) — product platform; payments-adjacent; large eng org.",
      jobNote: null,
      resume: RESUME_PAYMENTS,
      memoryPaths: ["profile.md", "companies/block.md"],
      pastDrafts: {
        coverLetters: [],
        shortAnswers: [
          shortAnswerEntry(
            "Senior Backend Engineer",
            "Plaid",
            "Why are you interested in working here?",
            "I keep gravitating to the financial-infrastructure layer — the ledgers, money-movement, and reconciliation that everything else is built on. What pulls me to a company like this is that the platform IS the product: the teams I want to be on treat correctness, idempotency, and clean internal APIs as the whole job, not a tax. I'd bring a bias toward instrumented, testable primitives and a paranoia about edge cases that only shows up at scale.",
          ),
        ],
      },
    },
    expect:
      "The open 'why are you applying / what excites you about working here' question → draft (a near-identical prior 'why are you interested' answer is on file to adapt to Block's platform context), NOT ask_user. Any identity/logistics fields → skip.",
    pins: [
      {
        contains: "why",
        verdict: "draft",
        why: "relevant prior 'why this company' answer on file → reuse",
      },
    ],
  },
  {
    name: "help-first-soft-hold-cover",
    notes:
      "Stripe Backend (Payments & Risk) with a SOFT hold in memory ('holding off on cover letters until I trust the flow'). Hank must still HELP — draft the cover letter from the on-file prior + resume — and surface a notice, never silently skip it.",
    slug: "stripe",
    titleContains: "Backend Engineer, Payments and Risk",
    inject: {
      profile: mergeProfile(
        THESIS_PAYMENTS,
        VOICE_PAYMENTS +
          " Note: holding off on letting Hank send cover letters until I trust the flow — still testing it, want to eyeball each one first.",
      ),
      frequentQ: null,
      companyNote:
        "Stripe — payments + risk infra; correctness-under-concurrency culture.",
      jobNote: null,
      resume: RESUME_PAYMENTS,
      memoryPaths: ["profile.md", "companies/stripe.md"],
      pastDrafts: {
        coverLetters: [
          coverEntry(
            "Senior Backend Engineer, Payments",
            "Adyen",
            PAYMENTS_PRIOR_COVER,
          ),
        ],
        shortAnswers: [],
      },
    },
    expect:
      "The 'holding off on cover letters until I trust the flow' note is a SOFT hold, not a standing instruction. The cover letter must NOT be skip — Hank helps anyway (draft from the on-file prior + resume) AND sets a top-level notice telling the user it saw the note and went ahead so they can judge it. A silent skip is a fail; helping without a notice is a fail. Stock questions still skip.",
    pins: [],
    coverLetterExpect: "not_skip",
    expectNotice: true,
  },
  {
    // Regression for the Reddit GraphQL form: stock factual fields that arrive
    // as plain `text` (so they slip isStockFieldType) must skip, not get drafted
    // or ask_user'd. This is the case the model has to get right on its own —
    // "How did you hear about this job?" and "name of your current (or most
    // recent) company" reach it as ordinary numbered questions, so the pin is
    // that the prompt's save-the-user-effort rule holds without a text hint
    // marking them. It sampled inconsistently before that rule existed (skip on
    // one job, ask_user on another; the company name got DRAFTED).
    name: "reddit-stock-text-fields-skip",
    notes:
      "Reddit GraphQL: 'How did you hear about this job?' + 'name of your current (or most recent) company' arrive as plain text → must skip (stock fill-ins), never draft/ask_user. LinkedIn + the selects skip too; cover letter is helped.",
    jobId: REDDIT_JOB_ID,
    inject: {
      profile: mergeProfile(THESIS_BACKEND, VOICE_BACKEND),
      frequentQ: null,
      companyNote:
        "Reddit — distributed GraphQL platform in Go; large-scale feeds/ranking infra.",
      jobNote: null,
      resume: RESUME_BACKEND_NO_OBS,
      memoryPaths: ["profile.md", "companies/reddit.md"],
      pastDrafts: NO_DRAFTS,
    },
    expect:
      "'How did you hear about this job?' and 'Please provide the name of your current (or most recent) company' are stock fill-in fields → skip (the user types them in seconds; an LLM draft adds nothing, and they're not personal prose to ask about). LinkedIn Profile → skip. The work-auth / sponsorship / privacy-consent selects → skip. A draft or ask_user on ANY of these is a fail. Cover letter → draft or ask_user (helped from the resume + posting), never silently skipped.",
    pins: [
      {
        contains: "how did you hear",
        verdict: "skip",
        why: "stock fill-in — user types it",
      },
      {
        contains: "current (or most recent) company",
        verdict: "skip",
        why: "one-word factual field; drafting adds no value",
      },
      { contains: "LinkedIn Profile", verdict: "skip", why: "identity URL" },
    ],
    coverLetterExpect: "not_skip",
  },
];

const SUB_AGENT_DESCRIPTION = `applicationDeciderSubAgent triages one job's application form. For each question (and the cover letter, if the form has one) it emits a verdict — draft / skip / ask_user — over the whole form at once. Reads: the form questions (+ type hints), the user's resume, profile.md, frequent_questions.md, companies/{slug}.md, jobs/{jobId}.md, and a past-drafts index (prior cover letters + short answers across all jobs). In this audit the user-side context is INJECTED (synthetic candidate) and the read tools are off, so the model decided from exactly the context shown below — prior bodies are inlined in full.

Output: { questions: [{question, verdict, reason}], coverLetter?: {verdict, reason}, notice? }.

Verdict meanings:
- draft = enough material to auto-write a strong, specific answer (resume / notes / a RELEVANT PRIOR ANSWER to adapt).
- skip = stock / identity / copy-paste / structured field (LinkedIn, GitHub, work-auth yes/no, country, degree, file uploads).
- ask_user = a genuine prose question (or cover letter) needing the user's own specifics, with no relevant prior answer to adapt — Hank will collect it in chat.`;

const RUBRIC = `Evaluate whether each verdict is the RIGHT call given the question and the INJECTED candidate material shown below. The auditor's intended pattern for this fixture is included as "Expected"; judge whether the actual verdicts are defensible against the rubric (a defensible deviation can still pass, but flag it).

**MUST (failure flags):**
- **Stock fields → skip**: identity/contact/logistics/URL/yes-no fields (LinkedIn, GitHub, country/city, work authorization, sponsorship, years of experience, prior employer/title, degree, school, "opt-in to WhatsApp", salary, start date) must be skip. A draft or ask_user on these is a fail.
- **Prose with material → draft, NOT ask_user**: an open prose question the resume/notes/thesis clearly support, OR that has a relevant prior answer in the past-drafts shown below, must be draft (adapt it). Re-asking the user for something already on file is a fail.
- **No draft on unsupported specifics (adjacency ≠ support)**: when a question asks about a SPECIFIC competency/system/achievement, draft is correct ONLY when the candidate material *directly evidences it* — enough that the concrete particulars (what system, what numbers, what tools) come from the material, not invention. If the material only *implies* it (resume says "ran a microservice network" and the question asks about "owning an observability system with alerting/on-call"), the correct verdict is ask_user; marking it draft is a fail. Conversely, when the resume DOES spell out the particulars, ask_user on it is over-cautious (a warn).
- **Help-first on soft holds — surface, don't silently withhold**: a SOFT / temporary hold ("holding off on cover letters until I trust the flow", "still testing it") is NOT a reason to skip. The decider must still HELP (draft if material exists, else ask_user) AND set a top-level notice so the user can react. Silently skipping because of a soft note is a fail; helping without surfacing a notice is also a fail. Only an explicit standing instruction ("I never write cover letters") justifies a skip.
- **Plain-English reasons**: every reason must be one short user-facing sentence with NO internal jargon (no "ask_user"/"skip"/"verdict"/"decider"/field-type names/memory paths). Leaking internal vocabulary is a fail.

**SHOULD (warn flags):**
- **Genuine personal-prose → ask_user**: a question needing a specific personal story/stance the material doesn't cover (a current coding-vs-ops split; "describe a conflict you navigated") should be ask_user, not an invented draft.
- **Cover-letter call calibrated**: draft when a relevant prior cover letter / strong material exists; ask_user when the user clearly needs to shape it.

Anchor the rationale to specific questions + their verdicts. Quote the question text.`;

function nowMs(): number {
  return Date.now();
}

type ResolvedJob = RoleAttrColumns & {
  id: string;
  title: string;
  rawContent: string | null;
  attributes: unknown;
  applicationQuestions: unknown;
  company: { name: string; slug: string | null } | null;
};

async function resolveJob(fx: Fixture): Promise<ResolvedJob | null> {
  // The real row's attributes come along: prod renders them above the posting,
  // so a fixture that nulled them would grade a thinner prompt than ships.
  const select = {
    id: true,
    title: true,
    rawContent: true,
    ...ROLE_ATTR_SELECT,
    attributes: true,
    applicationQuestions: true,
    company: { select: { name: true, slug: true } },
  } as const;
  if (fx.jobId) {
    return await prisma.job.findUnique({ where: { id: fx.jobId }, select });
  }
  if (fx.slug && fx.titleContains) {
    return await prisma.job.findFirst({
      where: {
        company: { slug: fx.slug },
        title: { contains: fx.titleContains, mode: "insensitive" },
        rawContent: { not: null },
        applicationQuestions: { path: ["status"], equals: "ok" },
      },
      select,
      orderBy: { title: "asc" },
    });
  }
  return null;
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

  // --only=<substr> runs just the matching fixtures (cheap iteration loop).
  const only = process.argv
    .find((a) => a.startsWith("--only="))
    ?.slice("--only=".length);
  const fixtures = only
    ? FIXTURES.filter((f) => f.name.includes(only))
    : FIXTURES;
  // --thinking=<budget> turns on extended thinking for the decide pass (the
  // thinking-vs-no-thinking measurement). Omit for the default (no thinking).
  const thinkingArg = process.argv
    .find((a) => a.startsWith("--thinking="))
    ?.slice("--thinking=".length);
  const thinkingBudget = thinkingArg ? Number(thinkingArg) : undefined;

  process.stdout.write(
    `\n🔍 Sub-agent audit — applicationDeciderSubAgent\nRun ID: ${runId}\nFixtures: ${fixtures.length}${only ? ` (filtered by "${only}")` : ""}${thinkingBudget ? ` · thinking=${thinkingBudget}` : ""}\nUser: ${user.email}\n\n`,
  );

  for (const fx of fixtures) {
    const t0 = nowMs();
    process.stdout.write(`▶ ${fx.name} — ${fx.notes.slice(0, 70)}\n`);
    try {
      const job = await resolveJob(fx);
      if (!job) {
        process.stdout.write(
          `   ⚠ SKIP: job not found (${fx.slug ?? fx.jobId} / ${fx.titleContains ?? ""})\n\n`,
        );
        continue;
      }
      const cr = await runOneCase({
        fx,
        job,
        userId: user.id,
        sessionId: session.id,
        judgeClient,
        thinkingBudget,
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
  fx: Fixture;
  job: ResolvedJob;
  userId: string;
  sessionId: string;
  judgeClient: Anthropic;
  thinkingBudget?: number;
}): Promise<CaseReport> {
  const { fx, job } = args;
  const envelope =
    job.applicationQuestions as ApplicationQuestionsEnvelope | null;
  const formQs: ApplicationQuestion[] =
    envelope?.status === "ok" && Array.isArray(envelope.questions)
      ? envelope.questions
      : [];
  const wantsCover =
    ((envelope?.status === "ok" || envelope?.status === "empty") &&
      envelope.coverLetter === true) ||
    formQs.some((q) => /\bcover\s*letter\b/i.test(q.question));

  const inj = fx.inject;
  const pastCl = inj.pastDrafts.coverLetters
    .map((e) => `- ${e.jobTitle} @ ${e.companyName}:\n  "${e.snippet}"`)
    .join("\n");
  const pastSa = inj.pastDrafts.shortAnswers
    .map(
      (e) =>
        `- [${e.jobTitle} @ ${e.companyName}] Q: ${e.question}\n  A: ${e.answerSnippet}`,
    )
    .join("\n");

  const contextMarkdown = [
    `### Fixture: ${fx.name}`,
    `- ${fx.notes}`,
    "",
    `**Auditor's expected pattern:** ${fx.expect}`,
    "",
    `### Job: ${job.title} @ ${job.company?.name ?? "?"}`,
    `### Application form (${formQs.length} questions${wantsCover ? " + cover letter" : ""})`,
    formQs.length
      ? formQs
          .map(
            (q, i) =>
              `${i + 1}. "${q.question}"${q.type ? ` (type=${q.type})` : ""}${q.required ? " [required]" : ""}`,
          )
          .join("\n")
      : "_(no questions)_",
    "",
    `### Injected candidate context`,
    "",
    `**profile.md:** ${inj.profile ? "\n```md\n" + clip(inj.profile, 1600) + "\n```" : "_(empty)_"}`,
    "",
    `**Background:** ${inj.resume ? "\n```md\n" + clip(inj.resume, 2200) + "\n```" : "_(none)_"}`,
    "",
    `**frequent_questions.md:** ${inj.frequentQ ? "\n```md\n" + clip(inj.frequentQ, 1500) + "\n```" : "_(empty)_"}`,
    "",
    `**companies note:** ${inj.companyNote ? "\n```md\n" + clip(inj.companyNote, 1200) + "\n```" : "_(empty)_"}`,
    "",
    `**Past cover letters on file:** ${pastCl ? "\n" + pastCl : "_(none)_"}`,
    "",
    `**Past short answers on file:** ${pastSa ? "\n" + pastSa : "_(none)_"}`,
  ].join("\n");

  // The SAME partition prod runs, not a copy of it — the audit has to grade the
  // question set decideApplicationForm would actually send.
  const { draftable, stockDecisions } = partitionApplicationForm(formQs);

  const result = await runSubAgent(
    // --thinking swaps the def's declared reasoning for real extended thinking,
    // which is the A/B this flag exists to run: thinking REPLACES the scratchpad
    // rather than stacking on it (the runner drops the forced tool_choice and
    // omits the `analysis` field when thinking is on). A prior measurement
    // found budget=1500 never better and sometimes worse.
    args.thinkingBudget
      ? {
          ...applicationDeciderSubAgent,
          reasoning: { mode: "thinking" as const, budget: args.thinkingBudget },
        }
      : applicationDeciderSubAgent,
    {
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
      jobNotePath: `jobs/${job.id}.md`,
      jobNote: inj.jobNote,
      resume: inj.resume,
      profile: inj.profile,
      frequentQuestions: inj.frequentQ,
      pastDrafts: inj.pastDrafts,
      draftable,
      allQuestions: formQs,
      formWantsCoverLetter: wantsCover,
    },
    args,
  );

  // Mechanical checks against the fixture's pins (informational; the judge gates).
  let mech = "";
  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    const d = {
      questions: [...stockDecisions, ...result.output.questions],
      coverLetter: result.output.coverLetter,
      notice: result.output.notice,
    };
    const counts = { draft: 0, skip: 0, ask_user: 0 } as Record<string, number>;
    for (const q of d.questions)
      counts[q.verdict] = (counts[q.verdict] ?? 0) + 1;

    const pinResults: string[] = [];
    let pinsHit = 0;
    for (const pin of fx.pins ?? []) {
      const match = d.questions.find((q) =>
        q.question.toLowerCase().includes(pin.contains.toLowerCase()),
      );
      if (!match) {
        pinResults.push(
          `  • "${pin.contains}" → (not found in form) — pin n/a`,
        );
        continue;
      }
      const ok = match.verdict === pin.verdict;
      if (ok) pinsHit++;
      pinResults.push(
        `  • "${pin.contains}" → ${match.verdict} (want ${pin.verdict}) ${ok ? "✓" : "✗"} [${pin.why}]`,
      );
    }
    const pinTotal = (fx.pins ?? []).length;

    let clResult = "";
    if (fx.coverLetterExpect && fx.coverLetterExpect !== "none") {
      const got = d.coverLetter?.verdict ?? "(no cover letter emitted)";
      const ok =
        fx.coverLetterExpect === "not_skip"
          ? d.coverLetter != null && d.coverLetter.verdict !== "skip"
          : got === fx.coverLetterExpect;
      clResult = `  • cover letter → ${got} (want ${fx.coverLetterExpect}) ${ok ? "✓" : "✗"}`;
    }
    let noticeResult = "";
    if (fx.expectNotice) {
      const ok = !!d.notice;
      noticeResult = `  • notice surfaced → ${d.notice ? "yes" : "NO"} (want yes) ${ok ? "✓" : "✗"}`;
    }

    mech = [
      `**Mechanical checks** (informational — the judge gates):`,
      pinTotal ? `- key questions: ${pinsHit}/${pinTotal} matched` : null,
      ...pinResults,
      clResult || null,
      noticeResult || null,
    ]
      .filter((l): l is string => l !== null && l !== "")
      .join("\n");

    outputMarkdown = [
      d.notice
        ? `**notice (surfaced — helped despite a soft hold):** ${d.notice}`
        : null,
      `**verdicts:** ${d.questions.length} questions — draft=${counts.draft}, skip=${counts.skip}, ask_user=${counts.ask_user}`,
      d.coverLetter
        ? `**cover letter:** ${d.coverLetter.verdict} — ${d.coverLetter.reason}`
        : "**cover letter:** (form has none)",
      "",
      mech,
      "",
      ...d.questions.map(
        (q) =>
          `- [${q.verdict}] "${q.question}"\n    ↳ ${q.reason || "_(no reason)_"}`,
      ),
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    outputSummary = `${d.notice ? "NOTICE " : ""}draft=${counts.draft} skip=${counts.skip} ask_user=${counts.ask_user}${d.coverLetter ? ` cl=${d.coverLetter.verdict}` : ""}`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "applicationDeciderSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "applicationDeciderSubAgent",
    caseName: fx.name,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `${formQs.length}q${wantsCover ? "+cl" : ""}, job=${job.company?.name ?? "?"}`,
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
