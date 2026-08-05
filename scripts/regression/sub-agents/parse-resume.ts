// Audit harness for parseResumeSubAgent (transform — résumé document → the
// user's background, merged).
//
// Two passes per fixture, because the sub-agent does two things:
//
//   1. TRANSCRIBE — parse a test user's stored Resume.fileBytes with no existing
//      background. The judge never sees the PDF, so it grades what IS checkable
//      without the source: full detail rather than a summary, no contact info,
//      no "Objective" blurb, sane structure.
//   2. MERGE — parse the SAME document again, this time against an existing
//      background built from pass 1 PLUS injected facts no résumé carries (a
//      chat-derived role and a correction). Those injected facts ARE the ground
//      truth: a correct merge keeps every one of them and does not emit a second
//      heading for a role the document restates.
//
// parseResumeSubAgent is pure (the caller persists), so no dryRun is needed.

import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { parseResumeSubAgent } from "../../../src/server/subagents/registry/parseResume";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";

type Fixture = {
  label: string;
  notes: string;
  match: { email?: string; fileNameContains?: string };
};

export const FIXTURES: Fixture[] = [
  {
    label: "admin",
    notes: "a test user's stored résumé",
    match: { email: "admin@example.com" },
  },
  {
    label: "second-user",
    notes: "a second test user's stored résumé",
    match: { email: "user-b@example.com" },
  },
  {
    label: "third-user",
    notes: "third resume (different format)",
    match: { fileNameContains: "third-user" },
  },
];

// Facts NO résumé contains, spliced into the existing background before the
// merge pass. Losing any of them is the failure the merge exists to prevent;
// they're phrased so the judge can check for them literally.
const INJECTED_CHAT_FACTS = `## From chat

### Contract Engineer — Halberd Systems (Mar 2019 – Sep 2019)
- Six-month contract rebuilding their batch ingestion in Python. Not on any resume — mentioned in conversation.

## Corrections
- The team described as "the platform team" was 4 people, not 40.`;

const SUB_AGENT_DESCRIPTION = `parseResumeSubAgent turns a résumé document into the user's BACKGROUND note (markdown), which is stored as resume.md and is the single thing every downstream sub-agent reads. It is a transcription, not a summary: every role, employer, date range, bullet, project, technology and education entry on the document must survive, at full detail. It excludes contact details (name/address/phone/email/links) and the résumé's own "Objective"/"Summary" self-marketing blurb, since those are not facts about the background. When an existing background is supplied it MERGES: the output is the complete merged note (it replaces the file wholesale), every existing fact survives unless this document directly corrects it, a role present in both becomes ONE entry carrying the union of their detail, and this document wins a direct conflict about the same fact.`;

const TRANSCRIBE_RUBRIC = `This is the TRANSCRIBE pass: the sub-agent was given a résumé PDF and no existing background. You cannot see the PDF, so judge only what the output itself shows.

**MUST (failure flags):**
- **Full detail, not a summary**: roles carry their bullets. A role reduced to a title+dates line with no substance, or a whole résumé compressed into a few sentences, is a fail — this is meant to be a transcription.
- **No contact info**: no email, phone, street address, or portfolio/LinkedIn URL anywhere in the output. Leaking any is a fail.
- **No "Objective"/"Summary" blurb**: a self-marketing paragraph ("results-driven engineer passionate about…") is a fail; it isn't a fact about the background.
- **Structured markdown**: recognizable sections (roles / education / skills) with a heading per role carrying title, employer and dates. A wall of prose is a fail.

**SHOULD (warn flags):**
- **Internal consistency**: date ranges shouldn't overlap implausibly or run backwards; titles should read like real titles.
- **No editorializing**: the output states what the document says without adding judgements about the candidate's seniority or quality.
- **Skills grounded**: a skills section should list concrete technologies, not padded generic terms.

Anchor your rationale to specific roles and sections in the output.`;

const MERGE_RUBRIC = `This is the MERGE pass: the sub-agent was given the SAME résumé document it had already transcribed, plus an existing background that contains that transcription AND a "From chat" section with facts no résumé carries. Its output replaces the note wholesale.

The existing background it was given is shown in the context above. Compare it against the output.

**MUST (failure flags):**
- **The chat-only role survives**: the Halberd Systems contract role (Mar–Sep 2019, Python batch ingestion) MUST still be present. Dropping it is the central failure — it exists nowhere else.
- **The correction survives**: the note that the platform team was 4 people, not 40, MUST still be present.
- **No duplicated roles**: a role the document and the existing background BOTH describe appears exactly ONCE. Two headings for the same job at the same employer is a fail, and so is any "From <filename>" / "From resume" section that stacks a second copy of the résumé alongside the first.
- **Nothing else lost**: every employer and education entry in the existing background is still in the output.

**SHOULD (warn flags):**
- **Clean seams**: the merged result reads as one coherent note, not two documents concatenated. The "## From chat" scaffolding should be folded into the normal role structure rather than preserved as a separate bucket.
- **Detail union**: where both sources described the same role, the merged entry carries the detail from both rather than just picking one.

Anchor your rationale to the specific roles you checked, naming which side each came from.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  const where = fx.match.email
    ? { user: { email: fx.match.email }, fileMime: "application/pdf" }
    : {
        fileName: { contains: fx.match.fileNameContains },
        fileMime: "application/pdf",
      };
  const resume = await prisma.resume.findFirst({
    where,
    select: { userId: true, fileName: true, fileBytes: true },
  });
  if (!resume)
    throw new Error(`no PDF resume matching ${JSON.stringify(fx.match)}`);

  const bytes = new Uint8Array(resume.fileBytes);
  // Bill against the admin user's key regardless of whose resume it is.
  const parse = (existingBackground: string | null) =>
    runSubAgent(
      parseResumeSubAgent,
      {
        fileName: resume.fileName,
        existingBackground,
        source: { kind: "pdf" as const, bytes },
      },
      { userId: ctx.userId },
    );

  const first = await parse(null);
  if (!first.ok) throw new Error(`transcribe pass: ${first.error}`);
  const transcription = first.output.markdown;

  // The merge input: this run's own transcription plus facts only chat knows.
  const existingBackground = `${transcription}\n\n${INJECTED_CHAT_FACTS}`;
  const second = await parse(existingBackground);
  if (!second.ok) throw new Error(`merge pass: ${second.error}`);
  const merged = second.output.markdown;

  const clip = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n)}\n[...truncated for judge]` : s;

  const transcribeContext = [
    `### Resume: ${resume.fileName} (${fx.label})`,
    "",
    "The PDF itself is not shown — judge the output on its own terms.",
  ].join("\n");
  const transcribeOutput = ["```md", clip(transcription, 7000), "```"].join(
    "\n",
  );

  const mergeContext = [
    `### Resume: ${resume.fileName} (${fx.label}) — re-parsed against an existing background`,
    "",
    "### The existing background it was given",
    "```md",
    clip(existingBackground, 7000),
    "```",
  ].join("\n");
  const mergeOutput = ["```md", clip(merged, 8000), "```"].join("\n");

  const [transcribeJudge, mergeJudge] = await Promise.all([
    runJudge({
      client: ctx.judgeClient,
      subAgentName: "parseResumeSubAgent",
      subAgentDescription: SUB_AGENT_DESCRIPTION,
      contextMarkdown: transcribeContext,
      outputMarkdown: transcribeOutput,
      rubric: TRANSCRIBE_RUBRIC,
      votes: 3,
    }),
    runJudge({
      client: ctx.judgeClient,
      subAgentName: "parseResumeSubAgent",
      subAgentDescription: SUB_AGENT_DESCRIPTION,
      contextMarkdown: mergeContext,
      outputMarkdown: mergeOutput,
      rubric: MERGE_RUBRIC,
      votes: 3,
    }),
  ]);

  // One report per fixture, so a bad merge can't pass unnoticed behind a clean
  // transcription: the case takes the WORSE of the two verdicts.
  const severity = { pass: 0, warn: 1, fail: 2 } as const;
  const judge =
    severity[mergeJudge.verdict] >= severity[transcribeJudge.verdict]
      ? mergeJudge
      : transcribeJudge;

  return {
    subAgent: "parseResumeSubAgent",
    caseName: fx.label,
    caseKind: "real",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost:
      judgeCost(transcribeJudge.usage) + judgeCost(mergeJudge.usage),
    inputSummary: `${resume.fileName}, transcribed=${transcription.length}ch, merge-input=${existingBackground.length}ch`,
    outputSummary: `transcribe=${transcribeJudge.verdict}, merge=${mergeJudge.verdict} (${merged.length}ch)`,
    contextMarkdown: [transcribeContext, "", "---", "", mergeContext].join(
      "\n",
    ),
    outputMarkdown: [
      "## Pass 1 — transcription",
      transcribeOutput,
      "",
      `**Judge:** ${transcribeJudge.verdict} — ${transcribeJudge.rationale}`,
      "",
      "## Pass 2 — merged with injected chat facts",
      mergeOutput,
      "",
      `**Judge:** ${mergeJudge.verdict} — ${mergeJudge.rationale}`,
    ].join("\n"),
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "parseResumeSubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) => `${f.label.padEnd(10)} ${f.notes}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
