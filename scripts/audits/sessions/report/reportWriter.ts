// Markdown report for one chunked session audit. Sections:
//   - Header (run metadata + cost + filing counts)
//   - Wrap-up assessment + cross-window findings
//   - Per-chunk summaries (findings + forwardSummary the auditor wrote)
//   - Flat list of every filed finding for triage

import fs from "fs";
import path from "path";

import type { ChunkResult, WrapUpResult } from "../agent/auditor";
import type { AuditTurn } from "../driver/replay";

export type ReportArgs = {
  artifactsDir: string;
  sessionId: string;
  userEmail: string;
  windowStartAt: Date;
  windowEndAt: Date;
  turns: AuditTurn[];
  chunkResults: ChunkResult[];
  wrapUp: WrapUpResult | null;
  filed: number;
  bumped: number;
  costUsd: number;
  model: string;
  chunkSize: number;
};

function escMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function writeReport(args: ReportArgs): string {
  const lines: string[] = [];
  lines.push(`# Session audit — ${args.sessionId}`);
  lines.push("");
  lines.push(`- **User:** ${args.userEmail}`);
  lines.push(
    `- **Window:** ${args.windowStartAt.toISOString()} → ${args.windowEndAt.toISOString()}`,
  );
  lines.push(`- **Turns audited:** ${args.turns.length}`);
  lines.push(
    `- **Chunks:** ${args.chunkResults.length} (size ${args.chunkSize})`,
  );
  lines.push(`- **Model:** ${args.model}`);
  lines.push(`- **AdminNotes filed:** ${args.filed} new, ${args.bumped} bumps`);
  lines.push(`- **Cost:** $${args.costUsd.toFixed(4)}`);
  lines.push("");

  if (args.wrapUp) {
    lines.push(`## Wrap-up assessment`);
    lines.push("");
    lines.push(args.wrapUp.overallAssessment);
    lines.push("");
    if (args.wrapUp.wrapUpFindings.length) {
      lines.push(
        `### Cross-window findings filed at wrap-up (${args.wrapUp.wrapUpFindings.length})`,
      );
      lines.push("");
      for (const f of args.wrapUp.wrapUpFindings) {
        lines.push(
          `- **[${f.severity}]** \`${f.dedupKey}\` (${f.category}) — ${f.summary}`,
        );
      }
      lines.push("");
    }
  }

  // Chunk-level breakdown
  lines.push(`## Chunks`);
  lines.push("");
  lines.push(`| Chunk | Turns | Findings | Cost |`);
  lines.push(`|---|---|---|---|`);
  for (const c of args.chunkResults) {
    lines.push(
      `| ${c.chunkIndex} | ${c.turnRange.firstTurn}–${c.turnRange.lastTurn} | ${c.findings.length} | $${c.costUsd.toFixed(4)} |`,
    );
  }
  lines.push("");

  for (const c of args.chunkResults) {
    lines.push(
      `### Chunk ${c.chunkIndex} (turns ${c.turnRange.firstTurn}–${c.turnRange.lastTurn})`,
    );
    lines.push("");
    lines.push(`**Findings (${c.findings.length}):**`);
    lines.push("");
    if (c.findings.length === 0) {
      lines.push(`- (none)`);
    } else {
      for (const f of c.findings) {
        lines.push(
          `- Turn ${f.turnIndex} — **[${f.severity}]** \`${f.dedupKey}\` (${f.category}) — ${escMd(f.summary)}`,
        );
      }
    }
    lines.push("");
    lines.push(`**Forward summary (handed to chunk ${c.chunkIndex + 1}):**`);
    lines.push("");
    lines.push("```");
    lines.push(c.forwardSummary);
    lines.push("```");
    lines.push("");
  }

  // Flat findings dump — easy triage view
  const allFindings = [
    ...args.chunkResults.flatMap((c) =>
      c.findings.map((f) => ({
        source: `chunk ${c.chunkIndex}, turn ${f.turnIndex}`,
        finding: f,
      })),
    ),
    ...(args.wrapUp?.wrapUpFindings ?? []).map((f) => ({
      source: "wrap-up",
      finding: f,
    })),
  ];
  if (allFindings.length > 0) {
    lines.push(`## All filed findings (${allFindings.length})`);
    lines.push("");
    for (const { source, finding: f } of allFindings) {
      lines.push(
        `### [${f.severity}] \`${f.dedupKey}\` (${f.category}) — ${source}`,
      );
      lines.push("");
      lines.push(`**${f.summary}**`);
      lines.push("");
      lines.push(f.context);
      lines.push("");
    }
  }

  const reportPath = path.join(
    args.artifactsDir,
    `${args.sessionId}.report.md`,
  );
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  fs.writeFileSync(reportPath, lines.join("\n"));
  return reportPath;
}
