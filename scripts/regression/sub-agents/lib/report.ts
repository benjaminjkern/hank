// Markdown report rendering for sub-agent audits.
//
// One report per audit run. Per-case verdict + judge rationale, per-sub-agent
// aggregate, run-level summary. Written to docs/audits/sub-agent-audit-<date>.md.

import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

import type { JudgeResult, JudgeVerdict } from "./judge";

export type CaseReport = {
  subAgent: string;
  caseName: string;
  caseKind: "real" | "synthetic_adversarial" | "historical_failure";
  caseDescription: string;
  source: "local" | "live";
  durationMs: number;
  subAgentUsdCost: number;
  judgeUsdCost: number;
  // What the sub-agent saw (briefly — full context is in contextMarkdown
  // for the judge but we summarize here for the report)
  inputSummary: string;
  // What the sub-agent output (one-line summary for the report)
  outputSummary: string;
  // Full markdown of both, kept in a fold-out section
  contextMarkdown: string;
  outputMarkdown: string;
  judge: JudgeResult;
  error?: string;
};

export type RunReport = {
  runId: string;
  startedAt: string;
  cases: CaseReport[];
};

export function renderRunReport(run: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Sub-agent audit report — ${run.startedAt}`);
  lines.push("");
  lines.push(`Run ID: \`${run.runId}\``);
  lines.push("");
  lines.push(renderSummary(run));
  lines.push("");

  const bySubAgent = new Map<string, CaseReport[]>();
  for (const c of run.cases) {
    const arr = bySubAgent.get(c.subAgent) ?? [];
    arr.push(c);
    bySubAgent.set(c.subAgent, arr);
  }

  for (const [subAgent, cases] of bySubAgent) {
    lines.push(`## ${subAgent}`);
    lines.push("");
    lines.push(renderSubAgentSummary(cases));
    lines.push("");
    for (const c of cases) {
      lines.push(renderCase(c));
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderSummary(run: RunReport): string {
  const totalCost = run.cases.reduce(
    (s, c) => s + c.subAgentUsdCost + c.judgeUsdCost,
    0,
  );
  const judgeCost = run.cases.reduce((s, c) => s + c.judgeUsdCost, 0);
  const subAgentCost = run.cases.reduce((s, c) => s + c.subAgentUsdCost, 0);
  const verdictCounts = countVerdicts(run.cases);
  const lines = [
    "## Run summary",
    "",
    `- Cases run: ${run.cases.length}`,
    `- Verdicts: ${verdictCell("pass", verdictCounts.pass)} · ${verdictCell("warn", verdictCounts.warn)} · ${verdictCell("fail", verdictCounts.fail)}`,
    `- Cost: ${money(totalCost)} (sub-agent ${money(subAgentCost)} + judge ${money(judgeCost)})`,
  ];
  return lines.join("\n");
}

function renderSubAgentSummary(cases: CaseReport[]): string {
  const v = countVerdicts(cases);
  const cost = cases.reduce(
    (s, c) => s + c.subAgentUsdCost + c.judgeUsdCost,
    0,
  );
  const avg = cases.reduce((s, c) => s + c.judge.score, 0) / cases.length;
  return [
    `- Cases: ${cases.length}`,
    `- Verdicts: ${verdictCell("pass", v.pass)} · ${verdictCell("warn", v.warn)} · ${verdictCell("fail", v.fail)}`,
    `- Average score: ${avg.toFixed(2)}/5`,
    `- Cost: ${money(cost)}`,
  ].join("\n");
}

function renderCase(c: CaseReport): string {
  const lines: string[] = [];
  const verdictBadge = verdictCell(c.judge.verdict, undefined);
  lines.push(`### ${verdictBadge} ${c.caseName} _(score ${c.judge.score}/5)_`);
  lines.push("");
  lines.push(`- Kind: \`${c.caseKind}\` · Source: \`${c.source}\``);
  lines.push(`- ${c.caseDescription}`);
  lines.push(`- Input: ${c.inputSummary}`);
  lines.push(`- Output: ${c.outputSummary}`);
  lines.push(
    `- Duration: ${(c.durationMs / 1000).toFixed(1)}s · Cost: sub-agent ${money(c.subAgentUsdCost)} + judge ${money(c.judgeUsdCost)} = ${money(c.subAgentUsdCost + c.judgeUsdCost)}`,
  );
  lines.push("");
  if (c.error) {
    lines.push(`**Error:** ${c.error}`);
    lines.push("");
  }
  lines.push(`**Judge rationale:** ${c.judge.rationale}`);
  if (c.judge.strengths.length > 0) {
    lines.push("");
    lines.push("**Strengths:**");
    for (const s of c.judge.strengths) lines.push(`- ${s}`);
  }
  if (c.judge.concerns.length > 0) {
    lines.push("");
    lines.push("**Concerns:**");
    for (const s of c.judge.concerns) lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Sub-agent inputs (what the judge saw)</summary>");
  lines.push("");
  lines.push(c.contextMarkdown);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Sub-agent output (what the judge saw)</summary>");
  lines.push("");
  lines.push(c.outputMarkdown);
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

function countVerdicts(cases: CaseReport[]): Record<JudgeVerdict, number> {
  const out: Record<JudgeVerdict, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of cases) out[c.judge.verdict]++;
  return out;
}

function verdictCell(v: JudgeVerdict, count: number | undefined): string {
  const sym = v === "pass" ? "✓" : v === "warn" ? "⚠" : "✗";
  const label = `${sym} ${v}`;
  return count === undefined ? label : `${label} ${count}`;
}

function money(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export async function writeReport(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}
