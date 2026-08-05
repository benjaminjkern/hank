// Audit harness for enrichJobSubAgent (transform — scan-step pass 1).
//
// Transform sub-agents get audited too: an LLM call's output should hold up to
// what a more capable model would produce for the same task. Here that means
// the Haiku enrichment summary stays LOSSLESS (drops boilerplate, keeps every
// concrete fact) and the extracted scalars are faithful (never guessed).
//
// Fixtures select a real job at a watchlist company by title keyword (robust to
// job-id churn since the audit hits the same DB the app writes). The sub-agent
// neither reads the Job nor writes back, so nothing here persists.

import {
  ROLE_ATTR_SELECT,
  roleAttrPairs,
  toRoleAttrs,
} from "../../../src/server/entities/jobs/roleAttrs";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { enrichJobSubAgent } from "../../../src/server/subagents/registry/enrichJob";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";

type Fixture = {
  slug: string;
  titleContains: string;
  notes: string;
};

export const FIXTURES: Fixture[] = [
  {
    slug: "exa",
    titleContains: "Software Engineer, Infrastructure",
    notes: "infra eng — dense tech body",
  },
  { slug: "stripe", titleContains: "Backend", notes: "large-co backend role" },
  { slug: "notion", titleContains: "Engineer", notes: "product-eng posting" },
  {
    slug: "ramp",
    titleContains: "Engineer",
    notes: "fintech eng posting (comp often in body)",
  },
  {
    slug: "cohere",
    titleContains: "Engineer",
    notes: "research/infra-adjacent posting",
  },
];

const SUB_AGENT_DESCRIPTION = `enrichJobSubAgent compresses ONE job posting into a terse, lossless prose summary + a small set of extracted scalars (comp / location / remote / seniorityLevel / requiredYoE / employmentType). It is user-independent (no candidate, no fit judgement) and the result is cached on the global Job row. Output: { summary, scalars }.

A good enrichment:
- Summary DROPS boilerplate (EEO statements, generic benefits, mission marketing, "how to apply", legal footers) but KEEPS every concrete fact (responsibilities, required+preferred quals, level signals, required YoE, tech stack, team/org context, location & remote policy, comp, employment type, anything unusual).
- Is dense — a later step must decide fit from the summary alone without re-reading the body.
- Extracts a scalar ONLY when the posting states it (never guesses comp; never invents a level). Omitted scalars are correct when the body is silent.
- Contains NO candidate references or "good fit" language — that's a later step's job.`;

const RUBRIC = `Evaluate the enrichment against the posting body shown in the context.

**MUST (failure flags):**
- **Losslessness**: Every concrete fact in the body (responsibilities, required/preferred quals, level, YoE, tech stack, team/org, location/remote, comp, employment type) must survive into the summary. Dropping a stated requirement, the comp, or the location is a fail.
- **No fabrication**: The summary/scalars must not state facts absent from the body. Inventing a comp range, a level, or a YoE requirement is a fail.
- **Scalar honesty**: A scalar (comp/level/remote/YoE/type) must only be set when the body states it. Setting comp when the body has none is a fail; omitting comp when the body clearly states it is a fail.
- **No candidate/fit language**: Any "good fit", "strong match", or candidate reference is a fail — this step is candidate-independent.

**SHOULD (warn flags):**
- **Boilerplate dropped**: EEO/benefits/mission/legal boilerplate should NOT appear in the summary. Including it is a warn.
- **Density**: The summary should be tight, not a near-verbatim copy of the body. Excessive padding is a warn.
- **Comp recovery**: Boards often omit comp from structured fields but state it in the body — extracting it there is the single biggest win. Missing an in-body comp is at least a warn.

Anchor your rationale to specific facts you can verify present-or-missing between the body and the summary.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  const job = await prisma.job.findFirst({
    where: {
      rawContent: { not: null },
      company: { slug: fx.slug },
      title: { contains: fx.titleContains, mode: "insensitive" },
    },
    select: {
      id: true,
      title: true,
      ...ROLE_ATTR_SELECT,
      rawContent: true,
      attributes: true,
      company: { select: { name: true } },
    },
    orderBy: { title: "asc" },
  });
  if (!job)
    throw new Error(`no job at ${fx.slug} matching "${fx.titleContains}"`);

  const body = (job.rawContent ?? "").trim();
  // Mirrors what the sub-agent itself renders, placeholder and all.
  const knownFields = roleAttrPairs(toRoleAttrs(job), {
    emptyPlaceholder: "(none)",
  }).join(", ");

  const contextMarkdown = [
    `### ${job.title} @ ${job.company?.name ?? fx.slug}`,
    `**Known structured fields:** ${knownFields}`,
    "",
    `### Posting body (${body.length} chars)`,
    "```",
    body.slice(0, 5000) +
      (body.length > 5000
        ? "\n[...truncated for judge — sub-agent saw full body]"
        : ""),
    "```",
  ].join("\n");

  // The sub-agent no longer reads the Job or writes back, so there's no `force`
  // (nothing to cache-skip) and no `dryRun` (nothing to persist) — we just hand
  // it the posting and read the enrichment it returns.
  const result = await runSubAgent(
    enrichJobSubAgent,
    {
      title: job.title,
      ...toRoleAttrs(job),
      attributes: job.attributes,
      body,
    },
    ctx,
  );

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    const s = result.output.scalars;
    outputMarkdown = [
      `**Summary (${result.output.summary.length} chars):**`,
      "```",
      result.output.summary,
      "```",
      "",
      `**Scalars:**`,
      `- comp: ${s.comp ?? "_(omitted)_"}`,
      `- location: ${s.location ?? "_(omitted)_"}`,
      `- remote: ${s.remote ?? "_(omitted)_"}`,
      `- seniorityLevel: ${s.seniorityLevel ?? "_(omitted)_"}`,
      `- requiredYoE: ${s.requiredYoE ?? "_(omitted)_"}`,
      `- employmentType: ${s.employmentType ?? "_(omitted)_"}`,
      `- department: ${s.department ?? "_(omitted)_"}`,
    ].join("\n");
    const set = Object.entries(s)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    outputSummary = `summary ${result.output.summary.length}ch, scalars set: ${set.join(",") || "none"}`;
  }

  const judge = await runJudge({
    client: ctx.judgeClient,
    subAgentName: "enrichJobSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "enrichJobSubAgent",
    caseName: `${fx.slug}/${job.title}`.slice(0, 50),
    caseKind: "real",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `body=${body.length}ch`,
    outputSummary,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "enrichJobSubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) =>
      `${f.slug.padEnd(10)} "${f.titleContains}" — ${f.notes}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
