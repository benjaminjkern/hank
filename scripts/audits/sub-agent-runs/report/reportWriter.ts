// Markdown report for one runtime-audit invocation: per-operation sections with
// the weird-output + coverage-gap findings, plus a header rollup.

import fs from "fs";
import path from "path";

import type { OperationAuditResult } from "../agent/auditor";

function nowStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export function writeReport(args: {
  artifactsDir: string;
  runAtIso: string;
  model: string;
  chunkSize: number;
  dbHost: string;
  results: OperationAuditResult[];
  totalRuns: number;
  totalCost: number;
}): string {
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  const reportPath = path.join(
    args.artifactsDir,
    `runtime-audit-${nowStamp(args.runAtIso)}.md`,
  );

  const totalFiled = args.results.reduce((n, r) => n + r.filed, 0);
  const totalBumped = args.results.reduce((n, r) => n + r.bumped, 0);
  const weird = args.results.reduce(
    (n, r) => n + r.findings.filter((f) => f.kind === "weird_output").length,
    0,
  );
  const gaps = args.results.reduce(
    (n, r) => n + r.findings.filter((f) => f.kind === "coverage_gap").length,
    0,
  );

  const lines: string[] = [];
  lines.push(`# Sub-agent runtime audit — ${args.runAtIso}`);
  lines.push("");
  lines.push(
    `- Model: \`${args.model}\` · chunk size: ${args.chunkSize} · DB: \`${args.dbHost}\``,
  );
  lines.push(
    `- Operations audited: ${args.results.length} · runs: ${args.totalRuns}`,
  );
  lines.push(
    `- Findings: ${weird} weird-output, ${gaps} coverage-gap · AdminNotes: ${totalFiled} new, ${totalBumped} bumped`,
  );
  lines.push(`- Cost: $${args.totalCost.toFixed(4)}`);
  lines.push("");

  for (const r of args.results) {
    lines.push(
      `## ${r.operation} — ${r.runsAudited} run(s), ${r.chunks} chunk(s)`,
    );
    if (r.skippedNoSession > 0)
      lines.push(
        `_(${r.skippedNoSession} finding(s) had no session to anchor and were report-only.)_`,
      );
    if (r.findings.length === 0) {
      lines.push("");
      lines.push("_No findings._");
      lines.push("");
      continue;
    }
    for (const kind of ["weird_output", "coverage_gap"] as const) {
      const fs2 = r.findings.filter((f) => f.kind === kind);
      if (fs2.length === 0) continue;
      lines.push("");
      lines.push(
        `### ${kind === "weird_output" ? "Weird outputs" : "Coverage gaps"} (${fs2.length})`,
      );
      for (const f of fs2) {
        lines.push(
          `- **[${f.severity}] ${f.shape}** (run \`${f.runId}\`) — ${f.summary}`,
        );
        for (const cl of f.context.split("\n")) lines.push(`  > ${cl}`);
      }
    }
    lines.push("");
  }

  fs.writeFileSync(reportPath, lines.join("\n") + "\n");
  return reportPath;
}
