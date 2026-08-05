// Audit harness for logoVerifierSubAgent (transform, VISION).
//
// Caveat that shapes this harness: the LLM judge is TEXT-ONLY — it can't see the
// favicon. So the real signal is field-pinning the `verdict` against known-answer
// favicon pairs (a company's own favicon → correct; a different company's favicon
// → wrong). The judge runs only on a divergence, and can then assess just the
// rationale/betterUrl coherence (not the pixels). Nothing is written: the
// sub-agent only returns a verdict — persisting it is applyLogoVerdict, which
// this harness never calls.
//
// Favicons come from Google's favicon service (always PNG — the same source the
// app derives logos from). A fetch failure on any URL yields verdict=uncertain,
// which the pin will flag.

import { runVerifyCompanyLogo } from "../../../src/server/procedures/registry/verifyCompanyLogo";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";

const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

type Fixture = {
  companyName: string;
  candidateLogoUrl: string;
  notes: string;
  // Known-answer pin. oneOf where vision could reasonably land on uncertain.
  expect: {
    equals?: "correct" | "wrong" | "uncertain";
    oneOf?: Array<"correct" | "wrong" | "uncertain">;
  };
};

export const FIXTURES: Fixture[] = [
  {
    companyName: "Stripe",
    candidateLogoUrl: favicon("stripe.com"),
    notes: "company's own favicon → correct",
    expect: { equals: "correct" },
  },
  {
    companyName: "Vercel",
    candidateLogoUrl: favicon("vercel.com"),
    notes: "company's own favicon → correct",
    expect: { equals: "correct" },
  },
  {
    companyName: "Anthropic",
    candidateLogoUrl: favicon("openai.com"),
    notes: "a DIFFERENT company's logo → wrong",
    expect: { equals: "wrong" },
  },
  {
    companyName: "Ramp",
    candidateLogoUrl: favicon("stripe.com"),
    notes: "wrong-company favicon → wrong",
    expect: { equals: "wrong" },
  },
  {
    companyName: "Cognition Labs",
    candidateLogoUrl: favicon("cognition.com"),
    notes:
      "the canonical slug-vs-domain collision (Cognition Labs is cognition.ai)",
    expect: { oneOf: ["wrong", "uncertain"] },
  },
];

const SUB_AGENT_DESCRIPTION = `logoVerifierSubAgent checks one candidate logo image against a company name via Claude vision and returns { analysis, verdict: correct|wrong|uncertain, betterUrl? }. correct = the image is recognizably the company's official logo/wordmark; wrong = it's a different company's logo, a placeholder, or unrelated (common when a favicon was derived from the wrong domain — e.g. an ATS slug that doesn't match the real domain); uncertain = can't tell (too small/blurry/generic). betterUrl is only set on wrong + high confidence. The verdict is the load-bearing output; analysis is the private scratchpad it wrote first — a one-sentence description of what it saw.`;

const RUBRIC = `NOTE: you cannot see the image — judge only the coherence of the response, since the verdict itself is checked mechanically against the known answer.

**MUST (failure flags):**
- **Rationale coherence**: analysis must be a sensible one-sentence description consistent with the verdict. A "correct" verdict with a rationale describing a mismatch (or vice-versa) is a fail.
- **betterUrl discipline**: betterUrl should appear ONLY with verdict=wrong. A betterUrl on a "correct"/"uncertain" verdict is a fail. A guessed/implausible betterUrl is a warn-to-fail.

**SHOULD (warn flags):**
- **Calibration language**: For a known wrong-domain collision, an over-confident "correct" rationale is a warn even if you can't see the image.
- **Note specificity**: "different company's logo" / "appears to be a placeholder" beats a generic "doesn't match".

The fixture's known-correct verdict is provided below for your reference. Focus your score on whether the rationale + betterUrl are internally coherent and appropriately calibrated.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  // Through the procedure, not the sub-agent directly: fetching the candidate
  // image is half of what this path does, and a fixture URL that 404s should
  // grade the same "uncertain" prod would return.
  const result = await runVerifyCompanyLogo(
    {
      companyName: fx.companyName,
      candidateLogoUrl: fx.candidateLogoUrl,
    },
    ctx,
  );

  const contextMarkdown = [
    `### Company: ${fx.companyName}`,
    `- Candidate logo URL: ${fx.candidateLogoUrl}`,
    `- ${fx.notes}`,
    `- **Known-correct verdict:** ${fx.expect.equals ?? fx.expect.oneOf?.join("/")}`,
  ].join("\n");

  const outputMarkdown = [
    `**verdict:** ${result.verdict}`,
    `**betterUrl:** ${result.betterUrl ?? "_(none)_"}`,
    `**analysis:** ${result.analysis ?? "_(none)_"}`,
  ].join("\n");

  const judge = await runJudge({
    client: ctx.judgeClient,
    subAgentName: "logoVerifierSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
    expectedFields: {
      verdict: fx.expect.equals
        ? { equals: fx.expect.equals, label: "expectedVerdict" }
        : {
            oneOf: fx.expect.oneOf as readonly string[],
            label: "expectedVerdict",
          },
    },
    actualFields: { verdict: result.verdict },
  });

  return {
    subAgent: "logoVerifierSubAgent",
    caseName: fx.companyName,
    caseKind: "synthetic_adversarial",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `expect=${fx.expect.equals ?? fx.expect.oneOf?.join("|")}`,
    outputSummary: `verdict=${result.verdict}${result.betterUrl ? " +betterUrl" : ""}`,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "logoVerifierSubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) => `${f.companyName.padEnd(16)} ${f.notes}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
