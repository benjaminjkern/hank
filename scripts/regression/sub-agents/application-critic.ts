// Audit harness for applicationCriticSubAgent (the post-draft recruiter-lens critic).
//
// Each fixture pairs a REAL job (stable global rawContent — the JD) with a
// synthetic candidate: an injected resume (ground truth for fact-checking), the
// candidate's other applications to the same company (cross-application
// consistency), and an APPLICATION UNDER REVIEW (a cover letter + short answers
// with a deliberately planted problem — or, for the clean fixture, none). The
// critic's job is to catch the planted problem WITHOUT inventing spurious ones,
// so the fixtures span the failure modes it exists to catch plus a clean
// control that a false-positive would fail:
//   - clean-grounded              → accurate, specific, consistent → expect no issues
//   - fabrication-unsupported     → a claim the résumé doesn't support
//   - internal-contradiction      → cover letter vs a short answer disagree
//   - numeric-duration-contradiction → same tenure stated two ways ("1.5 yrs" vs "2 yrs")
//   - cross-application           → contradicts another app to the same company
//   - cross-artifact-redundancy   → two artifacts lead with the same story/metric
//   - quality-generic             → accurate but doesn't answer "why THIS company"
//
// Run: pnpm exec tsx scripts/regression/sub-agents/application-critic.ts --live

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  JobInteractionStatus,
  PrismaClient,
} from "../../../src/generated/prisma/client";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "../../../src/server/entities/jobs/roleAttrs";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import {
  applicationCriticSubAgent,
  type SiblingApplication,
} from "../../../src/server/subagents/registry/applicationCritic";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Injected synthetic résumés (ground truth the critic fact-checks against).
// ---------------------------------------------------------------------------

const RESUME_INFRA = `## Roles

### Staff Platform Engineer — Acme (2022–present)
- Owned the service mesh, CI/CD, and the internal developer platform used by ~120 engineers.
- Built a multi-region deployment pipeline in Go, Kubernetes and Terraform; cut p99 deploy time from 40m to 8m.
- Ran the migration off a monolith to ~30 services.

### Backend Engineer — Cleo (2016–2022)
- Backend services in Go, Postgres and gRPC.

## Skills
Kubernetes, Terraform, Go, CI/CD, service mesh, Postgres

## Education

### BS Computer Science`;

// Backend IC who has NEVER owned observability — the fabrication trap. The
// closing line is the whole point: a draft claiming on-call or monitoring
// ownership is contradicted right here.
const RESUME_BACKEND_NO_OBS = `## Roles

### Staff Backend Engineer — Acme (2021–present)
- Architected and ran a microservice network handling ~50K requests/week.
- Owned the storage and query layer.
- Led the public API redesign; mentored 4 engineers.
- No on-call or observability ownership — the SRE team ran monitoring.

### Backend Engineer — Cleo (2014–2021)
- Payment-ledger services in Go.

## Skills
Go, Postgres, Kafka, gRPC, distributed-systems design, API design

## Education

### BS Computer Science`;

// Payments backend IC — currently at Cleo, ~8 years, IC (not a manager).
const RESUME_PAYMENTS = `## Roles

### Senior Backend Engineer, Payments — Cleo (2018–present)
- Owns the double-entry ledger and the money-movement APIs.
- Built a real-time fraud-scoring service that cut chargebacks ~25%.
- Individual contributor on a small team — not a manager.
- Focused on correctness under concurrency: idempotency, reconciliation, partial-failure edges.

## Skills
payments, ledgers, risk / fraud, Go, Java, Postgres, Kafka`;

function sibling(
  jobTitle: string,
  coverLetter: string | null,
  shortAnswers: Array<{ question: string; answer: string }> = [],
  overrides: Partial<SiblingApplication> = {},
): SiblingApplication {
  return {
    jobTitle,
    location: null,
    department: null,
    employmentType: null,
    compensation: null,
    appliedAgo: "3mo ago",
    status: JobInteractionStatus.WAITING_ON_RESPONSE,
    closeReason: null,
    coverLetter,
    shortAnswers,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

type Fixture = {
  name: string;
  slug: string;
  titleContains: string;
  notes: string;
  resume: string;
  siblings: SiblingApplication[];
  application: {
    coverLetter: string | null;
    shortAnswers: Array<{ question: string; answer: string }>;
  };
  expect: string;
  // Informational anchors for the judge (and a deterministic coverage line):
  expectClean?: boolean; // true → the critic should surface no blocking issue
  mustFlagTargets?: string[]; // item(s) it must flag (cover_letter / question text)
};

export const FIXTURES: Fixture[] = [
  {
    name: "clean-grounded",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    notes:
      "Accurate, specific, self-consistent application; résumé directly supports every claim; no siblings. The critic should return clean (no invented contradictions/fabrication flags). A false positive here is the failure.",
    resume: RESUME_INFRA,
    siblings: [],
    application: {
      coverLetter:
        "I've spent the last three years on the platform team at Acme owning the service mesh and the internal developer platform ~120 engineers build on. I built our multi-region deploy pipeline in Go and Terraform on Kubernetes and cut p99 deploy time from 40 minutes to 8, and I ran the migration off our monolith into about 30 services. Exa's infrastructure role is squarely the greenfield platform work I want more of — a small team where the deploy pipeline, the mesh, and the developer experience are still being shaped rather than maintained.",
      shortAnswers: [
        {
          question: "What's a system you're proud of building?",
          answer:
            "The multi-region deploy pipeline at Acme. It took p99 deploy time from 40 minutes to 8 and let ~120 engineers ship without hand-holding from the platform team.",
        },
      ],
    },
    expect:
      "Clean. Every claim (service mesh, multi-region pipeline, 40m→8m, ~120 engineers, monolith→30 services) traces to the résumé; the two items are consistent; the letter is specific to Exa's infra role. No issues at all, or at most a trivial polish note.",
    expectClean: true,
  },
  {
    name: "fabrication-unsupported",
    slug: "temporal",
    titleContains: "Staff Software Engineer, Observability",
    notes:
      "Observability JD; résumé owns NO observability (backend microservice network; SRE ran monitoring). The cover letter fabricates observability ownership (on-call, runbooks, named tools, MTTR). The critic MUST flag it as unsupported/blocking.",
    resume: RESUME_BACKEND_NO_OBS,
    siblings: [],
    application: {
      coverLetter:
        "Observability has been the core of my work for years. I owned our observability platform end to end at Acme: I built the alerting on Prometheus and Grafana, carried the on-call pager for three years, wrote the runbooks the whole team relied on during incidents, and drove MTTR from 40 minutes down to 6 with Datadog and PagerDuty. Temporal's observability role is exactly the ownership I've been doing, and I'd hit the ground running.",
      shortAnswers: [
        {
          question: "Describe your observability experience.",
          answer:
            "I instrumented every service I built, owned our SLOs and error budgets, and ran the incident-response rotation for our platform.",
        },
      ],
    },
    expect:
      "The critic must flag the cover letter (and the short answer) as unsupported_claim / blocking: the résumé shows a backend microservice network and explicitly says the SRE team ran monitoring — it does NOT support owning an observability platform, on-call/pager, runbooks, SLOs, or Datadog/Prometheus/Grafana/PagerDuty/MTTR figures. Missing this is a fail.",
    mustFlagTargets: ["cover_letter"],
  },
  {
    name: "internal-contradiction",
    slug: "stripe",
    titleContains: "API Engineer, Billing",
    notes:
      "Cover letter claims the candidate LED a 30-person org; a short answer says they were one of six engineers. Internal contradiction (also unsupported — the résumé shows an IC). The critic MUST flag the contradiction and name BOTH items.",
    resume: RESUME_PAYMENTS,
    siblings: [],
    application: {
      coverLetter:
        "As the engineer who led our 30-person payments platform organization at Cleo, I've seen billing systems at scale from the top. I set the technical direction for the ledger, money movement, and the fraud stack, and I'd bring that leadership to Stripe's billing team.",
      shortAnswers: [
        {
          question: "Tell us about the team you work on.",
          answer:
            "At Cleo I'm one of six engineers on the ledger team. It's a small, senior group — I own the double-entry ledger and the money-movement APIs as an individual contributor.",
        },
      ],
    },
    expect:
      "The critic must flag a contradiction: the cover letter says the candidate LED a 30-person org and set direction, while the short answer says they're one of six ICs — these can't both be true. The issue should list BOTH the cover_letter and the team question as targets. (The résumé backs the IC/6-person version, so the 30-person leadership claim is also unsupported.) Blocking.",
    mustFlagTargets: ["cover_letter", "Tell us about the team you work on."],
  },
  {
    name: "cross-application-inconsistency",
    slug: "stripe",
    titleContains: "Payments and Risk",
    notes:
      "The candidate already submitted another Stripe application (Billing) saying they're at Cleo, eight years. This application says they're at Plaid, three years. A recruiter comparing the two would notice. The critic MUST flag the cross-application inconsistency.",
    resume: RESUME_PAYMENTS,
    siblings: [
      sibling(
        "Backend / API Engineer, Billing",
        "Across my eight years at Cleo owning the double-entry ledger, correctness under concurrency has been the whole job. I'd bring that to Stripe's billing team.",
        [{ question: "Where do you currently work?", answer: "Cleo." }],
      ),
    ],
    application: {
      coverLetter: null,
      shortAnswers: [
        {
          question:
            "Where do you currently work, and why are you looking to leave?",
          answer:
            "After three years at Plaid, I'm ready to go deeper on real-time risk, which is why Stripe's payments-and-risk team is the right next step.",
        },
      ],
    },
    expect:
      "The critic must flag the inconsistency with the OTHER Stripe application: that one says the candidate is at Cleo (~8 years); this one says Plaid (3 years). A recruiter with both on file would catch it. Flag as cross_application (unsupported_claim is also acceptable — the résumé says Cleo too), targeting the current-company question. Blocking. Missing it is a fail.",
    mustFlagTargets: [
      "Where do you currently work, and why are you looking to leave?",
    ],
  },
  {
    name: "quality-generic",
    slug: "exa",
    titleContains: "Software Engineer, Backend",
    notes:
      "Factually fine, but the 'why Exa' answer is pure generic filler that never references anything specific to Exa. The critic should flag it as quality / doesn't-answer-the-question — testing that it judges quality, not just facts.",
    resume: RESUME_INFRA,
    siblings: [],
    application: {
      coverLetter: null,
      shortAnswers: [
        {
          question: "Why do you want to work at Exa specifically?",
          answer:
            "I'm deeply passionate about joining a fast-growing, innovative company where I can leverage my skills to drive real impact and grow my career. Exa seems like an amazing place to do meaningful work with talented people, and I'd be thrilled to contribute.",
        },
        {
          question: "What's a system you're proud of building?",
          answer:
            "The multi-region deploy pipeline at Acme — it cut p99 deploy time from 40 minutes to 8 for ~120 engineers.",
        },
      ],
    },
    expect:
      "The critic should flag the 'why Exa specifically' answer as quality / jd_mismatch: it's generic filler ('passionate', 'leverage my skills', 'amazing place') that never names anything specific to Exa (search/retrieval infra) and so doesn't actually answer 'why THIS company'. The second answer is fine and should NOT be flagged. Not necessarily blocking, but it must be surfaced.",
    mustFlagTargets: ["Why do you want to work at Exa specifically?"],
  },
  {
    // Regression for the prod miss (Fireworks AML Engineer, 2026-07-07): the
    // cover letter and a short answer stated the SAME tenure two different ways
    // ("year and a half" vs "two years"). A subtle same-fact numeric mismatch —
    // the DeepSeek forced-tool critic sailed past it 6/6 until the analysis-first
    // scratchpad + explicit number-by-number cross-check were added. Guards that.
    name: "numeric-duration-contradiction",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    notes:
      "Cover letter says 'the last year and a half' at Acme; a short answer says 'the last two years' at Acme — the SAME tenure stated two different ways. Not a narrative clash (like the 30-person fixture) but a quiet number mismatch a recruiter reading both back-to-back would catch. The critic MUST flag the contradiction and name BOTH items.",
    resume: RESUME_INFRA,
    siblings: [],
    application: {
      coverLetter:
        "I've spent the last year and a half at Acme owning the service mesh and the internal developer platform ~120 engineers build on — the multi-region deploy pipeline, the mesh, and the developer experience. Exa's infrastructure role is exactly the greenfield platform work I want more of.",
      shortAnswers: [
        {
          question: "Why do you want to work at Exa?",
          answer:
            "Over the last two years building the platform at Acme, I've seen how much leverage good infrastructure creates, and Exa's infra team is where I want to take that further — a small team still shaping the deploy pipeline and the mesh rather than maintaining them.",
        },
      ],
    },
    expect:
      "The critic must flag a contradiction: the cover letter says 'the last year and a half' at Acme while the short answer says 'the last two years' at Acme — the same tenure stated two different ways. It must list BOTH the cover_letter and the 'Why do you want to work at Exa?' question as targets. Blocking. Returning clean, or flagging only the (fine) quality of the answer, is the fail this fixture guards against.",
    mustFlagTargets: ["cover_letter", "Why do you want to work at Exa?"],
  },
  {
    // Regression for the second half of the same prod miss: the cover letter and
    // the "why us" answer both LED with the identical story + headline metric,
    // reading as a near-repeat back-to-back. Redundancy across artifacts wasn't
    // in the critic's mandate at all until this pass — everything here is
    // accurate and consistent, so the ONLY thing to catch is the overlap.
    name: "cross-artifact-redundancy",
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    notes:
      "Both the cover letter and the 'why Exa' answer OPEN with the same Acme multi-region-pipeline story and the same 40m→8m / ~120-engineers numbers. Every claim is accurate and the two agree — there is NO contradiction and NO fabrication. The only issue is that the second artifact restates the first, wasting its opening. The critic should flag redundancy (polish), naming both items.",
    resume: RESUME_INFRA,
    siblings: [],
    application: {
      coverLetter:
        "At Acme I built the multi-region deploy pipeline in Go and Terraform on Kubernetes and cut p99 deploy time from 40 minutes to 8, letting ~120 engineers ship without hand-holding from the platform team. Exa's infrastructure role is the greenfield platform work I want to go deeper on.",
      shortAnswers: [
        {
          question: "Why do you want to work at Exa?",
          answer:
            "At Acme I built the multi-region deploy pipeline that cut p99 deploy time from 40 minutes to 8 for ~120 engineers, so I know how much a small platform team can move. That's exactly why Exa appeals to me — the deploy pipeline and mesh are still being shaped, and I want to be one of the people shaping them.",
        },
      ],
    },
    expect:
      "Nothing here is contradictory or unsupported — every claim traces to the résumé and the two artifacts agree. The critic should catch the REDUNDANCY: the cover letter and the 'Why do you want to work at Exa?' answer both open with the identical Acme multi-region-pipeline story and the same 40m→8m / ~120-engineers numbers, so read back-to-back the second is a near-repeat. Flag it (kind=redundancy, polish is fine), naming BOTH items, and suggest the answer lead with a different, Exa-specific angle. It must NOT invent a contradiction or fabrication here.",
    mustFlagTargets: ["cover_letter", "Why do you want to work at Exa?"],
  },
];

const SUB_AGENT_DESCRIPTION = `applicationCriticSubAgent is a post-draft, recruiter-lens reviewer. AFTER a job's answers are drafted, it reviews the WHOLE application at once and returns { issues[] } — an empty array IS the clean verdict — where each issue = { targets[], severity: "blocking"|"polish", kind: "contradiction"|"unsupported_claim"|"cross_application"|"jd_mismatch"|"redundancy"|"quality"|"other", note }. targets name the item(s): the literal "cover_letter" or the exact short-answer question text.

It sees ONLY what a hiring-side reviewer would: the job description, the drafted application, the candidate's résumé (ground truth for fact-checking), and the candidate's other submitted applications to the SAME company (for cross-application consistency). It gets NO user memory. It does NOT rewrite — it only critiques; a separate drafter revises.

It should catch: (1) unsupported claims (a claim the résumé doesn't back), (2) internal contradictions across answers, (3) cross-application inconsistencies, (4) jd_mismatch / doesn't-answer-the-question, (5) generic/filler quality problems — WITHOUT inventing problems on a clean application.`;

const RUBRIC = `Evaluate the critic's output against the application, the injected résumé, and the sibling applications shown below. The auditor's intended outcome is in "Expected".

**MUST (failure flags):**
- **Catches the planted problem.** For every fixture except the clean one, there is a specific planted issue (fabrication / internal contradiction — including a subtle same-fact number/duration mismatch / cross-application inconsistency / cross-artifact redundancy / generic non-answer). The critic MUST surface an issue that identifies it. Missing it — returning "clean", or flagging only something unrelated — is a fail. Check the issue's \`targets\` actually point at the right item(s); for the contradiction and redundancy fixtures BOTH items must be named.
- **No false fabrication on the clean application.** On the clean fixture, the critic must NOT invent a blocking issue — no fake contradiction, no "unsupported" flag on a claim the résumé plainly supports. A trivial polish note is fine; a manufactured blocking issue is a fail. (Over-flagging a genuinely-clean application is as harmful as missing a real one.)
- **Grounded in what's shown.** Every issue the critic raises must be checkable against the JD / résumé / siblings shown. Flagging a "contradiction" that isn't actually contradictory, or an "unsupported claim" the résumé does support, is a fail.

**SHOULD (warn flags):**
- **Right kind + severity.** Factual/contradiction/cross-application issues should be \`blocking\`; pure style/generic/redundancy issues \`polish\` (a doesn't-actually-answer issue may be either). A badly-miscategorised kind is a warn.
- **Actionable notes.** Each note should name the specific claim/sentence and what's wrong, aimed at the writer — not vague ("could be stronger").
- **No pile-on.** Beyond the planted issue, it shouldn't manufacture several spurious extras.

Anchor the rationale to the specific issues the critic returned (quote its notes) and to the specific lines of the application they're about. State plainly whether the planted problem was caught.`;

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
    `\n🔍 Sub-agent audit — applicationCriticSubAgent\nRun ID: ${runId}\nFixtures: ${FIXTURES.length}\nUser: ${user.email}\n\n`,
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

function renderApplication(app: Fixture["application"]): string {
  const parts: string[] = [];
  parts.push(
    `**Cover letter:** ${app.coverLetter ? "\n```\n" + app.coverLetter + "\n```" : "_(none)_"}`,
  );
  if (app.shortAnswers.length) {
    parts.push("**Short answers:**");
    app.shortAnswers.forEach((a) => {
      parts.push(`- **Q:** ${a.question}\n  **A:** ${a.answer}`);
    });
  } else {
    parts.push("**Short answers:** _(none)_");
  }
  return parts.join("\n");
}

function renderSiblingsMd(siblings: SiblingApplication[]): string {
  if (!siblings.length) return "_(none on file)_";
  return siblings
    .map((s) => {
      const lines = [
        `- **${s.jobTitle}** (applied ${s.appliedAgo} · ${s.status})`,
      ];
      if (s.coverLetter) lines.push(`  - cover letter: "${s.coverLetter}"`);
      s.shortAnswers.forEach((a) =>
        lines.push(`  - Q: ${a.question} → A: ${a.answer}`),
      );
      return lines.join("\n");
    })
    .join("\n");
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
    `### Injected résumé (ground truth)`,
    `**Background:** ${fx.resume ? "\n```\n" + clip(fx.resume, 2000) + "\n```" : "_(none)_"}`,
    "",
    "",
    `### Other applications to this company (siblings)`,
    renderSiblingsMd(fx.siblings),
    "",
    `### Application under review`,
    renderApplication(fx.application),
  ].join("\n");

  // The posting is real (pulled above); the résumé + siblings are the fixture's,
  // so a pinned verdict stays coherent with the candidate it describes.
  const result = await runSubAgent(
    applicationCriticSubAgent,
    {
      jobTitle: job.title,
      companyName: job.company?.name ?? "(unknown company)",
      posting: {
        ...toRoleAttrs(job),
        attributes: job.attributes,
        body: job.rawContent,
        companyDescription: null,
      },
      coverLetter: fx.application.coverLetter,
      shortAnswers: fx.application.shortAnswers,
      resume: fx.resume,
      siblings: fx.siblings,
    },
    args,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    // Deterministic coverage line for the judge: did the critic flag what it
    // was supposed to (or, for the clean fixture, stay clean)?
    let coverage = "";
    if (fx.expectClean) {
      const blocking = result.output.issues.filter(
        (i) => i.severity === "blocking",
      );
      coverage = blocking.length
        ? `**⚠ coverage:** expected CLEAN but the critic raised ${blocking.length} blocking issue(s) — judge whether they're real or false positives.`
        : `**coverage:** expected clean; no blocking issues raised ✓`;
    } else if (fx.mustFlagTargets?.length) {
      const flagged = new Set(
        result.output.issues.flatMap((i) =>
          i.targets.map((t) => t.toLowerCase()),
        ),
      );
      const missing = fx.mustFlagTargets.filter(
        (t) =>
          ![...flagged].some(
            (f) => f.includes(t.toLowerCase()) || t.toLowerCase().includes(f),
          ),
      );
      coverage = missing.length
        ? `**⚠ coverage:** expected a flag on ${missing.map((m) => `"${m.slice(0, 40)}"`).join(", ")} — not obviously targeted (judge decides; the critic may have used slightly different target text).`
        : `**coverage:** all expected target(s) were flagged ✓`;
    }

    const issuesMd = result.output.issues.length
      ? result.output.issues
          .map(
            (i, n) =>
              `${n + 1}. [${i.severity}/${i.kind}] targets=${i.targets
                .map((t) => `"${t.slice(0, 50)}"`)
                .join(", ")}\n   ${i.note}`,
          )
          .join("\n")
      : "_(no issues)_";

    outputMarkdown = [
      `**verdict:** ${result.output.issues.length ? "revise" : "clean"}`,
      `**issue count:** ${result.output.issues.length}`,
      coverage || null,
      "",
      `**issues:**`,
      "",
      issuesMd,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    outputSummary = `${result.output.issues.length ? "revise" : "clean"}, ${result.output.issues.length} issues`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "applicationCriticSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "applicationCriticSubAgent",
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
