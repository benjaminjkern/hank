// LLM-as-judge for sub-agent audits.
//
// One call to Claude Opus 4.8 per case. Given the sub-agent's input context +
// output + a rubric (markdown), the judge returns a structured verdict the
// audit runner can render into a report.
//
// Why the most-capable available model: judgment-of-judgment is exactly where
// model capability matters most. With a peer-class model judging another
// peer-class model, the judge's blind spots tend to overlap with the agent's.
// The judge should sit a tier above the sub-agents under test, so it runs on
// the strongest available model rather than the ones the sub-agents use.
//
// Why a generic shape: every judgment sub-agent has different input/output
// types. Reducing to {contextMarkdown, outputMarkdown, rubric} lets the audit
// share one judge module across all sub-agents — rubric is the differentiator.
//
// Field-pinning fast path: judges are expensive. When a fixture has discrete
// pinned expectations (recommendedAction='skip', verdict='pass', rung=2,
// outcome='found'), the runJudge call can skip the LLM entirely if every
// pinned field matches what the sub-agent produced. See `expectedFields` on
// JudgeArgs and `checkExpectedFields` below.

import { getGraderClient, type GraderClient } from "../../../lib/graderLlm";

import type Anthropic from "@anthropic-ai/sdk";

// This module is imported by every one of the 16 sub-agent audit scripts, so
// it's the single place to declare that these runs are SYNTHETIC: the fixtures
// drive real sub-agents against fake data, and those runs must NOT be captured
// into SubAgentRun (or the sub-agent runtime audit would later re-audit fixture
// runs as if they were real production traffic). recordSubAgentRun honors this
// flag. See src/server/agent/subAgentRun.ts. (Set at module init — runs before
// any audit script's main() drives a sub-agent.)
process.env.HANK_DISABLE_SUBAGENT_CAPTURE = "1";

const JUDGE_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 2000;

export type JudgeVerdict = "pass" | "warn" | "fail";

export type JudgeResult = {
  verdict: JudgeVerdict;
  score: number; // 1-5; 5=excellent, 1=clearly wrong
  rationale: string; // 2-5 sentences
  strengths: string[];
  concerns: string[];
  usage: Anthropic.Usage;
};

export type JudgeArgs = {
  client: Anthropic;
  subAgentName: string; // e.g. "shortlistJobsSubAgent"
  // Free-form description of what the sub-agent's job is. Goes into the judge's
  // context so it knows what "good" means for this sub-agent.
  subAgentDescription: string;
  // Markdown describing what the sub-agent saw (input context: user profile,
  // candidate pool, memory state, etc.)
  contextMarkdown: string;
  // Markdown describing what the sub-agent produced (picks, reasoning,
  // declines, signals)
  outputMarkdown: string;
  // Per-sub-agent rubric. Specific must/should/must-not statements the judge
  // evaluates against.
  rubric: string;
  // K-of-N voting: run the judge `votes` times, take majority verdict. Each
  // vote is independent (no chain-of-thought sharing). Default 1 (single
  // vote, fastest/cheapest). Audit harness uses 3 to kill judge noise — the
  // first-pass Exa case had 3 different verdicts (PASS/FAIL/PASS) across
  // consecutive runs with identical input; majority-of-3 voting eliminates
  // that class of flip.
  votes?: number;
  // Field-pinning fast path: when the fixture has discrete expected fields
  // (recommendedAction='skip', verdict='pass', rung=2, outcome='found'), the
  // runner can pin them here. If every pinned field matches what the sub-
  // agent actually produced, runJudge skips the LLM entirely and returns a
  // synthetic PASS verdict with reason "exact match on N pinned fields". When
  // any pinned field diverges, the LLM judge still runs but is told what the
  // pin expected vs what the sub-agent produced, so it can evaluate whether
  // the divergence is acceptable (the model can reasonably disagree on score
  // calibration without being "wrong"). See checkExpectedFields below.
  expectedFields?: ExpectedFields;
  // The sub-agent's actual output fields, parallel to expectedFields. Each
  // key the runner pins in expectedFields must be present here.
  actualFields?: Record<string, unknown>;
};

// Pinned discrete-field expectations. Each entry: the expected value (single
// or one-of-set) and an optional describer for the rubric/judge prompt.
export type ExpectedFields = Record<
  string,
  | { equals: unknown; label?: string }
  | { oneOf: readonly unknown[]; label?: string }
  | { inRange: [number, number]; label?: string }
>;

export type FieldDivergence = {
  field: string;
  expected: string; // human-readable describe of what was pinned
  actual: string; // human-readable describe of what was produced
};

// Pure check: does the actual output satisfy every pinned expectation?
// Returns null if all match (run can skip the LLM); returns the array of
// divergences if any fail (LLM judge still runs, with the divergence list
// added to its context so it can assess whether the miss is acceptable).
function checkExpectedFields(
  expected: ExpectedFields | undefined,
  actual: Record<string, unknown> | undefined,
): FieldDivergence[] | null {
  if (!expected || Object.keys(expected).length === 0) return null;
  if (!actual) {
    return Object.entries(expected).map(([field, expectation]) => ({
      field,
      expected: describeExpectation(expectation),
      actual: "(no actual field provided)",
    }));
  }
  const divergences: FieldDivergence[] = [];
  for (const [field, expectation] of Object.entries(expected)) {
    const actualValue = actual[field];
    if (!matchesExpectation(actualValue, expectation)) {
      divergences.push({
        field,
        expected: describeExpectation(expectation),
        actual: JSON.stringify(actualValue ?? null),
      });
    }
  }
  return divergences.length === 0 ? null : divergences;
}

function matchesExpectation(
  actual: unknown,
  expectation: ExpectedFields[string],
): boolean {
  if ("equals" in expectation) {
    return actual === expectation.equals;
  }
  if ("oneOf" in expectation) {
    return expectation.oneOf.includes(actual);
  }
  if ("inRange" in expectation) {
    if (typeof actual !== "number") return false;
    const [min, max] = expectation.inRange;
    return actual >= min && actual <= max;
  }
  return false;
}

function describeExpectation(expectation: ExpectedFields[string]): string {
  const labelPrefix = expectation.label ? `${expectation.label}: ` : "";
  if ("equals" in expectation)
    return `${labelPrefix}${JSON.stringify(expectation.equals)}`;
  if ("oneOf" in expectation)
    return `${labelPrefix}one of ${JSON.stringify(expectation.oneOf)}`;
  if ("inRange" in expectation)
    return `${labelPrefix}between ${expectation.inRange[0]} and ${expectation.inRange[1]}`;
  return "(unknown expectation shape)";
}

const SYSTEM_PROMPT = `You are an evaluator auditing a single sub-agent invocation inside a job-application assistant called Hank. Hank's sub-agents make narrow judgment calls (shortlist picks, what's-next decisions, application drafting, etc.) on behalf of the main agent.

Your job is to assess whether THIS specific sub-agent invocation made reasonable judgment calls given the inputs it had. You are NOT the sub-agent's manager — you are not telling it what to do. You are reading what it did and evaluating it against a rubric.

Calibration:
- "pass" = the sub-agent did its job well. Picks are defensible, reasoning is grounded, signals are appropriate. Minor nitpicks are fine; flag them in concerns but the verdict stays pass.
- "warn" = the sub-agent did something noticeably suboptimal but not clearly wrong. Examples: missed an obvious candidate, picked one weak option, gave a generic proposal note, didn't flag confusion when inputs were ambiguous.
- "fail" = the sub-agent made a clearly wrong call. Examples: picked roles that obviously mismatch the user's stated level/preferences, declined when there were clear matches, fabricated reasoning, ignored explicit context.

Be fair to the sub-agent: it operates on limited context. If the inputs genuinely didn't support a confident pick, declining is the right call. If the user profile is sparse, generic reasoning is forgivable. Score against what was reasonable given the inputs, not against a perfect oracle.

Return JSON only. Use the rubric provided in the user message as your scoring guide.`;

export async function runJudge(args: JudgeArgs): Promise<JudgeResult> {
  const votes = args.votes ?? 1;
  if (votes < 1 || votes > 9) {
    throw new Error(`votes must be 1-9, got ${votes}`);
  }

  // Field-pinning fast path: when every pinned field on the fixture matches
  // what the sub-agent produced, skip the judge LLM entirely and synthesize
  // a PASS verdict. The pinned-fields check is deterministic and free;
  // running the LLM judge on an exact-match case is wasted spend + a vector
  // for judge noise on cases that have a clearly-right discrete answer.
  const divergences = checkExpectedFields(
    args.expectedFields,
    args.actualFields,
  );
  if (
    args.expectedFields &&
    Object.keys(args.expectedFields).length > 0 &&
    divergences === null
  ) {
    const fieldCount = Object.keys(args.expectedFields).length;
    return {
      verdict: "pass",
      score: 5,
      rationale: `Exact match on all ${fieldCount} pinned field${fieldCount === 1 ? "" : "s"}: ${Object.keys(args.expectedFields).join(", ")}. LLM judge skipped.`,
      strengths: [
        `Matched fixture expectation on ${Object.keys(args.expectedFields).join(", ")}`,
      ],
      concerns: [],
      usage: ZERO_USAGE,
    };
  }

  // Either no fields pinned, or pinned fields diverged. Run the LLM judge,
  // passing the divergence list (if any) so the model can assess whether
  // the miss is acceptable. The model can reasonably disagree with a
  // calibration pin (e.g. fixture expected fitScore=4 but sub-agent
  // produced 3 — that's not necessarily wrong); it shouldn't pass divergence
  // on a hard-pin (recommendedAction='skip' but sub-agent produced
  // 'shortlist' is a fail).
  const userContent = buildUserContent(args, divergences);

  // Route grader calls to the API key or the Claude subscription (Agent SDK)
  // per graderBackend(). On the subscription path args.client is ignored.
  const client = getGraderClient(args.client);

  // Independent votes — each is a fresh grader call. Run in parallel since
  // each is independent and ordering doesn't matter.
  const responses = await Promise.all(
    Array.from({ length: votes }, () =>
      callJudgeWithRetry(client, {
        model: JUDGE_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    ),
  );

  // Drop any vote whose response didn't parse (transient malformed JSON) and
  // decide from the survivors — a single bad parse shouldn't error the whole
  // case when the other votes are fine.
  const perVote = responses
    .map((r) => parseOneVote(r))
    .filter((v): v is JudgeResult => v !== null);

  if (perVote.length === 0) {
    throw new Error("All judge votes failed to parse");
  }
  if (perVote.length === 1) {
    return perVote[0];
  }
  return aggregateVotes(perVote);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// The judge model occasionally returns a transient overload (529) or rate
// limit (429); retry with backoff so a blip doesn't error out a whole audit
// case (especially with multi-try fixtures that fan out many judge calls).
async function callJudgeWithRetry(
  client: GraderClient,
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxAttempts = 4,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number } | null)?.status;
      const retryable =
        status === 429 || status === 500 || status === 503 || status === 529;
      if (!retryable || attempt === maxAttempts - 1) throw e;
      await sleep(1500 * 2 ** attempt); // 1.5s, 3s, 6s
    }
  }
  throw lastErr;
}

const ZERO_USAGE: Anthropic.Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
  server_tool_use: null,
  service_tier: null,
} as Anthropic.Usage;

function buildUserContent(
  args: JudgeArgs,
  divergences: FieldDivergence[] | null,
): string {
  const lines = [
    `# Sub-agent: ${args.subAgentName}`,
    "",
    args.subAgentDescription,
    "",
    "## Rubric",
    args.rubric,
    "",
    "## Sub-agent inputs",
    args.contextMarkdown,
    "",
    "## Sub-agent output",
    args.outputMarkdown,
    "",
  ];

  if (divergences && divergences.length > 0) {
    lines.push(
      "## Fixture-pinned field divergences",
      "",
      "The auditor pinned discrete field expectations on this fixture. The sub-agent's output diverged on the following — assess whether each divergence is acceptable per the rubric, or whether it indicates the sub-agent made the wrong call:",
      "",
      ...divergences.map(
        (d) =>
          `- **${d.field}**: pinned expected ${d.expected}, sub-agent produced ${d.actual}`,
      ),
      "",
      "A divergence on a hard-pinned field (recommendedAction, verdict, outcome, rung) usually indicates the sub-agent took the wrong action — score down accordingly. A divergence on a soft-pinned field (fitScore within a range, candidate count) can be acceptable if the rubric language supports it.",
      "",
    );
  }

  lines.push(
    "## Your task",
    "Score this invocation. Return JSON exactly matching this shape (no prose outside the JSON):",
    "```json",
    JSON.stringify(
      {
        verdict: "pass | warn | fail",
        score: "integer 1-5",
        rationale: "2-5 sentences explaining your verdict",
        strengths: ["short bullet", "short bullet"],
        concerns: ["short bullet", "short bullet"],
      },
      null,
      2,
    ),
    "```",
  );

  return lines.join("\n");
}

function parseOneVote(response: Anthropic.Message): JudgeResult | null {
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;
  const parsed = extractJsonObject(textBlock.text);
  if (!parsed) return null;
  return {
    verdict: normalizeVerdict(parsed.verdict),
    score: clampScore(parsed.score),
    rationale: String(parsed.rationale ?? "").trim(),
    strengths: arrayOfStrings(parsed.strengths),
    concerns: arrayOfStrings(parsed.concerns),
    usage: response.usage,
  };
}

// Majority-vote aggregation. Picks the most-voted verdict (tiebreak: prefer
// the more-cautious verdict — fail > warn > pass — since false negatives are
// worse than false positives for an audit). Score = median of all votes.
// Rationale = the rationale from the vote that matches the majority verdict
// with the closest-to-median score (the "central" vote). Strengths/concerns
// = union across all votes, deduped.
function aggregateVotes(votes: JudgeResult[]): JudgeResult {
  const counts: Record<JudgeVerdict, number> = { pass: 0, warn: 0, fail: 0 };
  for (const v of votes) counts[v.verdict]++;
  const max = Math.max(counts.pass, counts.warn, counts.fail);
  const majorityVerdict: JudgeVerdict =
    counts.fail === max ? "fail" : counts.warn === max ? "warn" : "pass";

  const scores = votes.map((v) => v.score).sort((a, b) => a - b);
  const medianScore = scores[Math.floor(scores.length / 2)];

  const matchingVotes = votes.filter((v) => v.verdict === majorityVerdict);
  const centralVote =
    matchingVotes.sort(
      (a, b) =>
        Math.abs(a.score - medianScore) - Math.abs(b.score - medianScore),
    )[0] ?? votes[0];

  const allStrengths = dedupShortStrings(votes.flatMap((v) => v.strengths));
  const allConcerns = dedupShortStrings(votes.flatMap((v) => v.concerns));

  const dissent = votes.length - counts[majorityVerdict];
  const consensusNote =
    dissent === 0
      ? ` (${votes.length}/${votes.length} judges agreed)`
      : ` (${counts[majorityVerdict]}/${votes.length} judges; ${dissent} dissent — fail=${counts.fail} warn=${counts.warn} pass=${counts.pass})`;

  // Sum usage across votes.
  const usage: Anthropic.Usage = {
    input_tokens: votes.reduce((s, v) => s + (v.usage.input_tokens ?? 0), 0),
    output_tokens: votes.reduce((s, v) => s + (v.usage.output_tokens ?? 0), 0),
    cache_creation_input_tokens: votes.reduce(
      (s, v) => s + (v.usage.cache_creation_input_tokens ?? 0),
      0,
    ),
    cache_read_input_tokens: votes.reduce(
      (s, v) => s + (v.usage.cache_read_input_tokens ?? 0),
      0,
    ),
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Usage;

  return {
    verdict: majorityVerdict,
    score: medianScore,
    rationale: centralVote.rationale + consensusNote,
    strengths: allStrengths,
    concerns: allConcerns,
    usage,
  };
}

function dedupShortStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const key = s.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 12);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  // Collect candidates: every ```json fenced block, then the raw text as a
  // fallback. A self-correcting judge sometimes emits TWO blocks — a malformed
  // first one ("stray semicolon…") then a corrected one — so we try each and
  // return the LAST that parses (the correction wins).
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1].trim());
  candidates.push(text); // unfenced fallback
  let parsed: Record<string, unknown> | null = null;
  for (const c of candidates) {
    const first = c.indexOf("{");
    const last = c.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) continue;
    try {
      parsed = JSON.parse(c.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      // keep the previous successful parse (if any) and try the next candidate
    }
  }
  return parsed;
}

function normalizeVerdict(v: unknown): JudgeVerdict {
  const s = String(v ?? "")
    .toLowerCase()
    .trim();
  if (s === "pass" || s === "warn" || s === "fail") return s;
  // Tolerant fallback — if the judge says "passed", "warning", etc.
  if (s.startsWith("pass")) return "pass";
  if (s.startsWith("warn")) return "warn";
  if (s.startsWith("fail")) return "fail";
  return "warn"; // safest default if the judge produced garbage
}

function clampScore(s: unknown): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter((x) => x.length > 0)
    .slice(0, 10);
}

// Judge pricing — mirrors the canonical `opus` tier in
// src/server/platform/usage/pricing.ts ($15/M input, $75/M output; cache_create =
// input × 1.25, cache_read = input × 0.1). Keep in sync if JUDGE_MODEL changes
// tier.
const JUDGE_PRICE = {
  input: 15,
  cacheCreate: 18.75,
  cacheRead: 1.5,
  output: 75,
};

export function judgeCost(u: Anthropic.Usage): number {
  return (
    ((u.input_tokens ?? 0) / 1e6) * JUDGE_PRICE.input +
    ((u.output_tokens ?? 0) / 1e6) * JUDGE_PRICE.output +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * JUDGE_PRICE.cacheCreate +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * JUDGE_PRICE.cacheRead
  );
}
