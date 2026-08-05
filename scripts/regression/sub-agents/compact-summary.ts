// Audit harness for the compaction summary pass (transform-like, Haiku).
//
// Drives compactSummarySubAgent (subagents/compactSummary.ts) over a real transcript —
// the last N ChatMessages for a user — with no ChatSession side effects. The
// judge grades the same contract SUMMARY_SYSTEM sets: capture only what
// would be LOST on truncation (preferences, open threads, in-progress work,
// corrections, explicit remember-requests) and do NOT restate durable state
// already in the DB (applied/skipped jobs, watchlist, focus, memory notes).

import { serializeTranscript } from "../../../src/server/agent/session/serializeTranscript";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { compactSummarySubAgent } from "../../../src/server/subagents/registry/compactSummary";

import { isEntrypoint } from "./lib/entrypoint";
import { runAudit, prisma, type AuditCtx } from "./lib/harness";
import { runJudge, judgeCost } from "./lib/judge";

import type { CaseReport } from "./lib/report";
// The same serializer runCompactSession feeds the pass in prod — a local copy here
// would silently drift from what's actually being graded.

type Fixture = {
  userEmail: string;
  messageCount: number;
  notes: string;
};

export const FIXTURES: Fixture[] = [
  {
    userEmail: "admin@example.com",
    messageCount: 40,
    notes: "admin user — sample activity",
  },
  {
    userEmail: "user-b@example.com",
    messageCount: 40,
    notes: "second active user",
  },
];

const SUB_AGENT_DESCRIPTION = `The compaction summary pass (Haiku) condenses the about-to-be-truncated portion of a chat transcript into a running summary stored on ChatSession.summary. Its contract: durable state (applied/skipped jobs, watchlist, focus, memory notes) is ALREADY persisted and re-readable via tools — do NOT restate it. Capture only what would be LOST without these messages: user preferences expressed in conversation, unresolved threads / open questions, decisions in progress and partial work (e.g. a cover-letter draft being iterated), things the user explicitly asked to remember, and mid-stream corrections/clarifications. Output: terse bullet points, ≤300 words, plain text, no preamble.`;

const RUBRIC = `Evaluate the summary against the transcript shown in context.

**MUST (failure flags):**
- **No fabrication**: Every claim in the summary must be grounded in the transcript. Inventing a preference or a decision is a fail.
- **Captures the losable signal**: If the transcript contains a clear in-conversation preference, an open thread, in-progress work, or an explicit "remember this", and the summary omits it entirely, that's a fail.
- **Doesn't restate durable state as the main content**: A summary that mostly re-lists which jobs were applied/skipped or what's on the watchlist (all re-readable from the DB) is missing the point — fail if that's the bulk of it.

**SHOULD (warn flags):**
- **Terseness**: Bullet points, ≤300 words, no preamble ("Here is a summary…"). Verbose prose is a warn.
- **Specificity**: "User won't take fully-remote-only roles" beats "user has preferences".
- **Open-thread surfacing**: Unresolved questions / partial drafts should be flagged so the next turn can pick them up.

If the transcript is thin (little beyond durable state), a short summary or near-empty result is acceptable — judge against what was actually in the messages, not an oracle.`;

async function runOneCase(fx: Fixture, ctx: AuditCtx): Promise<CaseReport> {
  const user = await prisma.user.findUnique({
    where: { email: fx.userEmail },
    select: { id: true },
  });
  if (!user) throw new Error(`no user ${fx.userEmail}`);

  const messages = await prisma.chatMessage.findMany({
    where: { session: { userId: user.id } },
    orderBy: { createdAt: "desc" },
    take: fx.messageCount,
    select: { role: true, content: true },
  });
  if (messages.length === 0) throw new Error(`no messages for ${fx.userEmail}`);
  messages.reverse();

  const transcript = serializeTranscript(messages);
  if (transcript.trim().length === 0)
    throw new Error(`empty transcript for ${fx.userEmail}`);

  // No sessionId: this is a fixture run, not a real compaction. The sub-agent
  // resolves its own client + model, so the audit grades exactly what prod runs.
  const result = await runSubAgent(
    compactSummarySubAgent,
    { messages, priorSummary: undefined },
    { userId: user.id },
  );
  if (!result.ok) throw new Error(result.error);
  const text = result.output;

  // Show the judge the FULL transcript — the summary pass saw all of it, so a
  // truncated view here makes the judge flag legitimately-summarized content
  // past the cut as "fabrication" (the known audit-truncation gotcha). The
  // serializer already caps each tool_result at 400 chars, so this stays bounded.
  const contextMarkdown = [
    `### User: ${fx.userEmail}`,
    `### Transcript (${messages.length} messages, ${transcript.length} chars)`,
    "```",
    transcript,
    "```",
  ].join("\n");

  const outputMarkdown = [
    `**Summary (${text.length} chars):**`,
    "",
    text || "_(empty)_",
  ].join("\n");

  const judge = await runJudge({
    client: ctx.judgeClient,
    subAgentName: "compactSummarySubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "compactSummarySubAgent",
    caseName: fx.userEmail,
    caseKind: "real",
    caseDescription: fx.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `transcript=${transcript.length}ch`,
    outputSummary: `summary=${text.length}ch`,
    contextMarkdown,
    outputMarkdown,
    judge,
  };
}

if (isEntrypoint(import.meta.url))
  runAudit<Fixture>({
    subAgentName: "compactSummarySubAgent",
    fixtures: FIXTURES,
    fixtureLabel: (f) => `${f.userEmail.padEnd(26)} ${f.notes}`,
    runCase: runOneCase,
  })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
