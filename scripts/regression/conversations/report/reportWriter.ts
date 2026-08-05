// Markdown reporting: a per-persona report (thought logs + overall perspective
// + terse lossless summary + halt callout) and a combined run index.

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import type { AssertionResult } from "./assertions";
import type { PersonaRunResult } from "../agent/personaAgent";
import type {
  CapturedAdminNote,
  CompanyScanOutcome,
} from "../isolation/teardown";
import type { Persona } from "../personas/types";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export type PersonaExtras = {
  adminNotes: CapturedAdminNote[];
  assertions: AssertionResult[];
  scanOutcomes: CompanyScanOutcome[];
};

export function writePersonaReport(
  dir: string,
  persona: Persona,
  result: PersonaRunResult,
  extras: PersonaExtras,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${persona.id}.md`);
  const lines: string[] = [];

  lines.push(`# ${persona.displayName} — ${persona.id}`);
  lines.push("");
  lines.push(
    `**End reason:** ${result.endReason}` +
      (result.error ? ` (error: ${result.error})` : ""),
  );
  if (result.halted) {
    lines.push("");
    lines.push(
      `## 🛑 HALT at turn ${result.halted.turn} — ${result.halted.category ?? "unspecified"}`,
    );
    lines.push("");
    lines.push(`> ${result.halted.evidence ?? "(no evidence given)"}`);
  }
  lines.push("");

  // Regression checks.
  lines.push(`## Checks`);
  lines.push("");
  for (const a of extras.assertions) {
    lines.push(`- ${a.passed ? "✅" : "❌"} **${a.name}** — ${a.detail}`);
  }
  lines.push("");

  // Per-company scan triage (prescan-aggressiveness data).
  lines.push(`## Scan outcomes (prescan/scan triage)`);
  lines.push("");
  if (extras.scanOutcomes.length === 0) {
    lines.push("_no companies scanned_");
  } else {
    for (const s of extras.scanOutcomes) {
      const status = Object.entries(s.byStatus)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const reasons = Object.entries(s.closeReasons)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      lines.push(
        `- **${s.company}** (${s.totalJobs} jobs) — ${status}${reasons ? ` | skips: ${reasons}` : ""}`,
      );
    }
  }
  lines.push("");

  // Hank's own diligence flags (captured before teardown).
  lines.push(`## Hank diligence flags (AdminNotes)`);
  lines.push("");
  if (extras.adminNotes.length === 0) {
    lines.push("_none_");
  } else {
    for (const n of extras.adminNotes) {
      lines.push(
        `- **[${n.severity}] ${n.category}**${n.dedupKey ? ` \`${n.dedupKey}\`` : ""}${n.occurrenceCount > 1 ? ` ×${n.occurrenceCount}` : ""}: ${n.summary}`,
      );
      if (n.context) lines.push(`  - ${n.context}`);
    }
  }
  lines.push("");
  lines.push(`**Persona goals:**`);
  for (const g of persona.goals) lines.push(`- ${g}`);
  lines.push("");

  if (result.wrapup) {
    lines.push(`## Overall perspective`);
    lines.push("");
    lines.push(result.wrapup.overallPerspective);
    lines.push("");
    lines.push(`## Terse lossless summary`);
    lines.push("");
    lines.push(result.wrapup.terseLosslessSummary);
    lines.push("");
  }

  lines.push(`## Turn-by-turn`);
  lines.push("");
  for (const t of result.turns) {
    const flagSuffix = t.harnessFlags.length
      ? ` ⚠️ ${t.harnessFlags.join("; ")}`
      : "";
    lines.push(
      `### Turn ${t.turn} — goal: ${t.goalProgress ?? "?"}, onTrack: ${t.assessment?.onTrack ?? "?"}${flagSuffix}`,
    );
    lines.push("");
    lines.push(`**What the user saw:**`);
    lines.push("");
    lines.push("```");
    lines.push(t.perceived);
    lines.push("```");
    lines.push("");
    lines.push(`**Thoughts:** ${t.thoughts}`);
    lines.push("");
    lines.push(`**Action:** ${t.actionResolved}`);
    lines.push("");
    lines.push(`**Assessment:** ${t.assessment?.notes ?? "(none)"}`);
    if (t.halt?.triggered) {
      lines.push("");
      lines.push(`**🛑 HALT (${t.halt.category}):** ${t.halt.evidence}`);
    }
    lines.push("");
    lines.push(`_cost so far: ${usd(t.costSoFarUsd)}_`);
    lines.push("");
  }

  writeFileSync(path, lines.join("\n"));
  return path;
}

export type RunMeta = {
  runId: string;
  model: string;
  maxTurns: number;
  spendCapUsd: number;
  startedAtIso: string;
};

export function writeIndex(
  dir: string,
  meta: RunMeta,
  entries: Array<{
    persona: Persona;
    result: PersonaRunResult;
    residueClean: boolean;
    extras: PersonaExtras;
  }>,
  totals: { personaUsd: number; hankUsd: number; totalUsd: number },
  globalHalt: {
    personaId: string;
    turn: number;
    category?: string;
    evidence?: string;
  } | null,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.md");
  const lines: string[] = [];

  lines.push(`# QA audit run ${meta.runId}`);
  lines.push("");
  lines.push(`- Started: ${meta.startedAtIso}`);
  lines.push(`- Persona model: ${meta.model}`);
  lines.push(`- Max turns/persona: ${meta.maxTurns}`);
  lines.push(`- Spend cap: ${usd(meta.spendCapUsd)}`);
  lines.push(
    `- Spend: total ${usd(totals.totalUsd)} (persona ${usd(totals.personaUsd)} + Hank ${usd(totals.hankUsd)})`,
  );
  lines.push("");

  if (globalHalt) {
    lines.push(`## 🛑 Run halted`);
    lines.push("");
    lines.push(
      `Persona **${globalHalt.personaId}** halted at turn ${globalHalt.turn} (${globalHalt.category ?? "unspecified"}). Remaining personas were skipped.`,
    );
    lines.push("");
    lines.push(`> ${globalHalt.evidence ?? "(no evidence)"}`);
    lines.push("");
  }

  lines.push(`## Personas`);
  lines.push("");
  lines.push(
    `| Persona | End reason | Halt | Checks | Flags | Residue | Report |`,
  );
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const e of entries) {
    const halt = e.result.halted
      ? `🛑 ${e.result.halted.category ?? "?"}`
      : "—";
    const residue = e.residueClean ? "clean" : "⚠️ LEFTOVER";
    const failed = e.extras.assertions.filter((a) => !a.passed);
    const checks =
      failed.length === 0
        ? `✅ ${e.extras.assertions.length}/${e.extras.assertions.length}`
        : `❌ ${failed.map((a) => a.name).join(", ")}`;
    const flags = e.extras.adminNotes.length
      ? `${e.extras.adminNotes.length}`
      : "—";
    lines.push(
      `| ${e.persona.id} | ${e.result.endReason} | ${halt} | ${checks} | ${flags} | ${residue} | [${e.persona.id}.md](./${e.persona.id}.md) |`,
    );
  }
  lines.push("");

  // Roll up failing checks across personas so regressions are obvious at a glance.
  const allFailed: string[] = [];
  for (const e of entries) {
    for (const a of e.extras.assertions) {
      if (!a.passed) allFailed.push(`${e.persona.id} · ${a.name}: ${a.detail}`);
    }
  }
  if (allFailed.length) {
    lines.push(`## ⚠️ Failing checks`);
    lines.push("");
    for (const f of allFailed) lines.push(`- ${f}`);
    lines.push("");
  }

  writeFileSync(path, lines.join("\n"));
  return path;
}
