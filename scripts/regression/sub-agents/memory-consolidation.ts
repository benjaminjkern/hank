// Audit harness for memoryConsolidationSubAgent.
//
// 2 fixtures from the DB: two test users' most recent messages each. Each gets
// serialized into a transcript and fed to the consolidation sub-agent, which
// only returns proposed writes — nothing is persisted.

import { isEntrypoint } from "./lib/entrypoint";

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";
import { serializeTranscript } from "../../../src/server/agent/session/serializeTranscript";
import { readMemory, listMemories } from "../../../src/server/memory/store";
import { resolveAnthropicApiKey } from "../../../src/server/platform/llm/resolveAnthropicKey";
import { loadMemoryConsolidationInput } from "../../../src/server/procedures/registry/consolidateSessionMemory";
import { runSubAgent } from "../../../src/server/subagents/lib/runSubAgent";
import { memoryConsolidationSubAgent } from "../../../src/server/subagents/registry/memoryConsolidation";

import { runJudge, judgeCost } from "./lib/judge";
import {
  type CaseReport,
  type RunReport,
  renderRunReport,
  writeReport,
} from "./lib/report";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export const FIXTURES: Array<{
  userEmail: string;
  messageCount: number;
  notes: string;
}> = [
  {
    userEmail: "admin@example.com",
    messageCount: 40,
    notes: "the admin user's last 40 messages — heavy activity",
  },
  {
    userEmail: "user-c@example.com",
    messageCount: 40,
    notes: "a second user's last 40 messages — active scan rounds",
  },
];

const SUB_AGENT_DESCRIPTION = `memoryConsolidationSubAgent runs at compaction time. Given a transcript (last N ChatMessages), it proposes memory writes — what new context from the session should be persisted to profile.md, companies/{slug}.md, jobs/{jobId}.md, frequent_questions.md, etc.

Output: { writes: [{ path, content, mode: 'append'|'replace', reason }], skipped: [{ path, reason }] }.

The consolidation should:
- Identify SPECIFIC new context worth persisting (a new preference learned, a new company-fact, a specific job conclusion) — not generic recaps
- Use append mode by default; replace ONLY when overwriting a clearly-superseded note
- Skip rather than write if the new content is trivial or already covered
- Cite the transcript when proposing a write (the 'reason' field should reference what was said)
- Default to conservatism — better to skip than to write garbage

Has a defensive guard: if mode=replace AND existing file >200 chars AND new content <33% of existing length, the replace silently downgrades to append (anti "distill returned one-liner that overwrote user's notes" bug).`;

const RUBRIC = `Evaluate the proposed writes against the transcript and existing memory.

**MUST (failure flags):**
- **No trivial writes**: Proposing to write generic, low-value content ("user is interested in jobs") or repeating context already in memory is a fail.
- **No fabrication**: Every proposed write must be grounded in the transcript. Inventing user preferences or fact-claims not present in the messages is a fail.
- **Path correctness**: Writes must use VALID memory paths (profile.md, companies/{slug}.md, jobs/{jobId}.md, contacts/, opportunities/, frequent_questions.md, etc.). Unknown paths are a fail.
- **No accidental overwrite**: replace mode on a substantial existing file with a tiny new content should NOT clear the file. (Guard is in place — if it slipped, that's a fail.)

**SHOULD (warn flags):**
- **Specificity in writes**: Proposed content should be specific ("user said they don't want any role at Bland AI", not "user has company preferences").
- **Right path**: A company-specific fact should go to companies/{slug}.md, not profile.md.
- **Append vs replace**: Should default to append. Using replace without strong justification is warn.
- **Skip rationale**: If important context was in transcript but NOT proposed for writing, that's a missed signal (warn).
- **'reason' field quality**: Should cite what was said ("user said X in response to Y"), not generic.

When you write the rationale, anchor to specific proposed writes (or notable omissions) and whether they're grounded + useful.`;

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

  // Use the admin user's API key to drive the judge regardless of fixture user.
  const sourceUser = await prisma.user.findUnique({
    where: { email: "admin@example.com" },
  });
  if (!sourceUser) throw new Error("source user not found");
  const judgeApiKey = await resolveAnthropicApiKey(sourceUser.id);
  const judgeClient = new Anthropic({ apiKey: judgeApiKey });

  const runId = `audit-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString().slice(0, 10);
  const cases: CaseReport[] = [];

  process.stdout.write(
    `\n🔍 Sub-agent audit — memoryConsolidationSubAgent\nRun ID: ${runId}\nFixtures: ${FIXTURES.length}\n\n`,
  );

  for (const fx of FIXTURES) {
    const t0 = Date.now();
    process.stdout.write(`▶ ${fx.userEmail.padEnd(25)} ${fx.notes}\n`);
    try {
      const cr = await runOneCase({ fixture: fx, judgeClient });
      cr.durationMs = Date.now() - t0;
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
  fixture: (typeof FIXTURES)[number];
  judgeClient: Anthropic;
}): Promise<CaseReport> {
  const user = await prisma.user.findUnique({
    where: { email: args.fixture.userEmail },
  });
  if (!user) throw new Error(`no user ${args.fixture.userEmail}`);

  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session)
    throw new Error(`no active session for ${args.fixture.userEmail}`);

  // Pull last N messages and serialize.
  const messages = await prisma.chatMessage.findMany({
    where: { session: { userId: user.id } },
    orderBy: { createdAt: "desc" },
    take: args.fixture.messageCount,
    select: { role: true, content: true, createdAt: true },
  });
  if (messages.length === 0)
    throw new Error(`no messages for ${args.fixture.userEmail}`);
  messages.reverse(); // chronological order

  const transcript = serializeTranscript(messages);

  // Snapshot existing memory for the judge's grounding check.
  const profile = await readMemory(user.id, "profile.md");
  const paths = await listMemories(user.id);
  const pathSummary = paths.length + " existing memory paths";

  const contextMarkdown = [
    `### User: ${user.email}`,
    `### Transcript (${messages.length} messages, ${transcript.length} chars)`,
    "```",
    transcript.slice(0, 5000) +
      (transcript.length > 5000 ? "\n[...truncated]" : ""),
    "```",
    "",
    `### Existing memory snapshot`,
    `profile.md (first 800 chars):`,
    profile ? "```md\n" + profile.slice(0, 800) + "\n```" : "_(empty)_",
    "",
    `Total memory paths: ${pathSummary}`,
  ].join("\n");

  // No dry-run flag needed: the sub-agent only PROPOSES writes now — applying
  // them is runConsolidateSessionMemory's job, which this harness never calls.
  // Same input assembly a real wrap does — the inventory is read from the
  // fixture user's live memory, exactly as prod would show it.
  const input = await loadMemoryConsolidationInput(user.id, messages);
  if (!input)
    throw new Error(`nothing said in ${args.fixture.userEmail}'s window`);

  const result = await runSubAgent(memoryConsolidationSubAgent, input, {
    userId: user.id,
    sessionId: session.id,
  });

  let outputMarkdown: string;
  let outputSummary: string;
  if (!result.ok) {
    outputMarkdown = `**ERROR:** ${result.error}`;
    outputSummary = `ERROR: ${result.error.slice(0, 120)}`;
  } else {
    const r = result.output;
    const lines: string[] = [];
    lines.push(`**Proposed writes (${r.writes.length}):**`);
    lines.push("");
    for (const w of r.writes) {
      lines.push(`#### \`${w.path}\` (${w.mode}, ${w.content.length} chars)`);
      lines.push(`_reason: ${w.reason}_`);
      lines.push("");
    }
    if (r.skipped.length > 0) {
      lines.push(`**Skipped (${r.skipped.length}):**`);
      for (const s of r.skipped) lines.push(`- \`${s.path}\`: ${s.reason}`);
    }
    outputMarkdown = lines.join("\n");
    outputSummary = `${r.writes.length} writes, ${r.skipped.length} skipped`;
  }

  const judge = await runJudge({
    client: args.judgeClient,
    subAgentName: "memoryConsolidationSubAgent",
    subAgentDescription: SUB_AGENT_DESCRIPTION,
    contextMarkdown,
    outputMarkdown,
    rubric: RUBRIC,
    votes: 3,
  });

  return {
    subAgent: "memoryConsolidationSubAgent",
    caseName: args.fixture.userEmail,
    caseKind: "real",
    caseDescription: args.fixture.notes,
    source: "local",
    durationMs: 0,
    subAgentUsdCost: 0,
    judgeUsdCost: judgeCost(judge.usage),
    inputSummary: `transcript=${transcript.length} chars`,
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
