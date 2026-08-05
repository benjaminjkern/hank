// Runs every judgement sub-agent audit script in turn and aggregates the
// per-sub-agent results into a single summary.
//
// ─ POLICY (read before running) ─────────────────────────────────────────────
//  1. Every sub-agent runs on the model it declares in its own file — DeepSeek
//     for all but the two vision ones (logo-verifier, parse-resume), which name
//     a Claude model because DeepSeek can't do vision. So the audit always
//     grades exactly what prod runs; there is nothing to flip. The Opus judge
//     builds its own Anthropic client and is unaffected either way.
//  2. ONLY run a sub-agent audit when you changed how that sub-agent RESPONDS —
//     its prompt, its side tools, or its output schema — and ONLY run the
//     one(s) you changed (via `--only <name>`). Orchestration / flow / schema
//     changes that merely *call* an unchanged sub-agent do NOT need a sub-agent
//     audit (the sub-agent's behavior is identical); validate those end-to-end
//     with the qa-audit (scripts/regression/conversations/) instead.
//     Don't run the full suite for a change that didn't touch a sub-agent.
//
// Use the full sweep only for a quarterly / pre-release pass. Day-to-day, run
// the single changed sub-agent directly (e.g.
// `pnpm exec tsx scripts/regression/sub-agents/shortlist-jobs.ts --live`).
//
// Usage:
//   pnpm exec tsx scripts/regression/sub-agents/run-all.ts
//     → run every audit sequentially against the local DB
//
//   pnpm exec tsx scripts/regression/sub-agents/run-all.ts --only shortlist-jobs,pre-scan
//     → run only the named one(s) — comma-separated for a subset
//
//   pnpm exec tsx scripts/regression/sub-agents/run-all.ts --skip extract-names,pre-scan
//     → run every audit EXCEPT the comma-separated names
//
//   pnpm exec tsx scripts/regression/sub-agents/run-all.ts --list
//     → print the registered audits and exit
//
//   DATABASE_URL='postgresql://...' pnpm exec tsx scripts/regression/sub-agents/run-all.ts --live
//     → run against a non-localhost DB (each audit script enforces this
//       individually; the runner forwards the flag).
//
// The sub-agents under test need a DeepSeek credential — the audit user must
// have a DeepSeek key on file, or canUseServerKey=true with DEEPSEEK_API_KEY
// set. The two vision audits additionally need an Anthropic one.

import "dotenv/config";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

// One entry per sub-agent that has an audit script. `class` distinguishes the
// two LLM-callsite shapes both audited here: judgement (tool-loop) and transform
// (single forced call). Transforms are audited too — an LLM call's output should
// hold up to what a more capable model would produce for the same task, which is
// exactly what the Opus 4.8 judge checks. Order is rough cost-ascending (cheap
// Haiku ones first, web_search-heavy ones last) so failures surface early.
const AUDIT_SCRIPTS: Array<{
  name: string;
  script: string;
  subAgent: string;
  class: "judgement" | "transform";
}> = [
  // --- transforms (single forced tool call; graded for lossless/faithful output) ---
  {
    name: "scan-job",
    script: "scan-job.ts",
    subAgent: "scanJobSubAgent",
    class: "transform",
  },
  {
    name: "profile-enrichment-check",
    script: "profile-enrichment-check.ts",
    subAgent: "profileEnrichmentCheckSubAgent",
    class: "judgement",
  },
  {
    name: "enrich-job",
    script: "enrich-job.ts",
    subAgent: "enrichJobSubAgent",
    class: "transform",
  },
  {
    name: "logo-verifier",
    script: "logo-verifier.ts",
    subAgent: "logoVerifierSubAgent",
    class: "transform",
  },
  {
    name: "compact-summary",
    script: "compact-summary.ts",
    subAgent: "compactSummarySubAgent",
    class: "transform",
  },
  // --- judgement (tool loop; graded for defensible calls + grounded reasoning) ---
  {
    name: "parse-resume",
    script: "parse-resume.ts",
    subAgent: "parseResumeSubAgent",
    class: "transform",
  },
  {
    name: "memory-consolidation",
    script: "memory-consolidation.ts",
    subAgent: "memoryConsolidationSubAgent",
    class: "judgement",
  },
  {
    name: "application-drafting",
    script: "application-drafting.ts",
    subAgent: "applicationDraftingSubAgent",
    class: "judgement",
  },
  {
    name: "application-decider",
    script: "application-decider.ts",
    subAgent: "applicationDeciderSubAgent",
    class: "judgement",
  },
  {
    name: "application-critic",
    script: "application-critic.ts",
    subAgent: "applicationCriticSubAgent",
    class: "transform",
  },
  {
    name: "shortlist-jobs",
    script: "shortlist-jobs.ts",
    subAgent: "shortlistJobsSubAgent",
    class: "judgement",
  },
  {
    name: "pre-scan",
    script: "pre-scan.ts",
    subAgent: "preScanJobBatchSubAgent",
    class: "judgement",
  },
  // web_search-backed — slowest + priciest, run last
  {
    name: "find-companies",
    script: "find-companies.ts",
    subAgent: "findCompaniesSubAgent",
    class: "judgement",
  },
  {
    name: "company-basic-info",
    script: "company-basic-info.ts",
    subAgent: "companyBasicInfoSubAgent",
    class: "judgement",
  },
];

// LLM callsites intentionally WITHOUT an audit here, with the reason:
//   - validateAnthropicKey (src/app/settings/actions.ts) — a 1-token auth ping,
//     no task output to grade.
//   - the four pipeline agents (default/walkthrough/enrichProfile/watchlistAdd
//     run.ts → agentRunner) — the streaming main agent; behavioral coverage
//     lives in scripts/scenarios/, not the judge harness.
// If you add a NEW judgement OR transform sub-agent, add its audit above.
const UNAUDITED_JUDGEMENT_SUB_AGENTS: string[] = [];

type AuditResult = {
  name: string;
  subAgent: string;
  exitCode: number | null;
  durationMs: number;
  // Last few lines of stdout — captures the per-case verdicts + total cost
  // each audit prints at the end.
  tail: string;
  totalJudgeCost: number | null;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    process.stdout.write(`Registered audits (${AUDIT_SCRIPTS.length}):\n`);
    for (const a of AUDIT_SCRIPTS) {
      process.stdout.write(
        `  [${a.class.padEnd(9)}] ${a.name.padEnd(22)} → ${a.subAgent}\n`,
      );
    }
    if (UNAUDITED_JUDGEMENT_SUB_AGENTS.length > 0) {
      process.stdout.write("\nSub-agents WITHOUT an audit (add one!):\n");
      for (const s of UNAUDITED_JUDGEMENT_SUB_AGENTS) {
        process.stdout.write(`  ${s}\n`);
      }
    } else {
      process.stdout.write(
        "\nAll judgement + transform sub-agents have an audit. ✓\n",
      );
    }
    return;
  }

  const onlyIdx = args.indexOf("--only");
  const onlyList =
    onlyIdx !== -1
      ? (args[onlyIdx + 1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const skipIdx = args.indexOf("--skip");
  const skipList =
    skipIdx !== -1
      ? (args[skipIdx + 1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const forwardArgs: string[] = [];
  if (args.includes("--live")) forwardArgs.push("--live");

  if (!process.env.DEEPSEEK_API_KEY) {
    process.stderr.write(
      "⚠ DEEPSEEK_API_KEY is not in the environment. Sub-agents will fail unless the audit user has a per-user DeepSeek key.\n",
    );
  }

  let selected =
    onlyList.length > 0
      ? AUDIT_SCRIPTS.filter((a) => onlyList.includes(a.name))
      : AUDIT_SCRIPTS;
  if (skipList.length > 0) {
    const before = selected.length;
    selected = selected.filter((a) => !skipList.includes(a.name));
    const skipped = before - selected.length;
    if (skipped > 0) {
      process.stdout.write(
        `\n⏭  Skipping ${skipped} audit(s) via --skip: ${skipList.join(", ")}\n`,
      );
    }
  }
  if (selected.length === 0) {
    process.stderr.write(
      `No audit matches --only ${onlyList.join(",")}. Use --list to see registered names.\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `\n📋 Running ${selected.length} audit${selected.length === 1 ? "" : "s"}:\n`,
  );
  for (const a of selected) {
    process.stdout.write(`  - ${a.name} (${a.subAgent})\n`);
  }
  process.stdout.write("\n");

  const results: AuditResult[] = [];
  for (const a of selected) {
    process.stdout.write(
      `\n${"━".repeat(70)}\n▶ ${a.name} (${a.subAgent})\n${"━".repeat(70)}\n\n`,
    );
    const result = await runOne(a, forwardArgs);
    results.push(result);
  }

  // Aggregate summary.
  process.stdout.write(
    `\n${"═".repeat(70)}\n📊 Run-all summary\n${"═".repeat(70)}\n\n`,
  );
  let totalCost = 0;
  let totalMs = 0;
  let failures = 0;
  for (const r of results) {
    const status = r.exitCode === 0 ? "✓" : "✗";
    const cost =
      r.totalJudgeCost !== null ? `$${r.totalJudgeCost.toFixed(3)}` : "—";
    process.stdout.write(
      `  ${status} ${r.name.padEnd(22)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  judge=${cost.padStart(8)}\n`,
    );
    if (r.totalJudgeCost !== null) totalCost += r.totalJudgeCost;
    totalMs += r.durationMs;
    if (r.exitCode !== 0) failures++;
  }
  process.stdout.write(
    `\n  Total: ${(totalMs / 1000).toFixed(1)}s elapsed, $${totalCost.toFixed(3)} in judge cost across ${results.length} audit${results.length === 1 ? "" : "s"}\n`,
  );
  if (failures > 0) {
    process.stdout.write(
      `  ${failures} audit${failures === 1 ? "" : "s"} exited non-zero — inspect output above\n`,
    );
    process.exit(1);
  }
}

async function runOne(
  audit: (typeof AUDIT_SCRIPTS)[number],
  forwardArgs: string[],
): Promise<AuditResult> {
  const t0 = Date.now();
  const scriptPath = join(HERE, audit.script);

  return await new Promise<AuditResult>((resolve) => {
    let stdoutBuffer = "";
    let totalJudgeCost: number | null = null;

    const child = spawn("pnpm", ["exec", "tsx", scriptPath, ...forwardArgs], {
      stdio: ["inherit", "pipe", "inherit"],
      env: process.env,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text); // stream live
      stdoutBuffer += text;
      // Most audit scripts print a "Total judge cost: $X.YYY" or
      // "Total cost: $X.YYY" line at the end. Parse whatever lands.
      const m = text.match(/Total (?:judge )?cost: \$(\d+\.\d+)/);
      if (m) totalJudgeCost = Number.parseFloat(m[1]);
    });

    child.on("close", (code) => {
      // Keep the last 12 lines of stdout for the summary view.
      const lines = stdoutBuffer.trim().split("\n");
      const tail = lines.slice(-12).join("\n");
      resolve({
        name: audit.name,
        subAgent: audit.subAgent,
        exitCode: code,
        durationMs: Date.now() - t0,
        tail,
        totalJudgeCost,
      });
    });

    child.on("error", (err) => {
      resolve({
        name: audit.name,
        subAgent: audit.subAgent,
        exitCode: -1,
        durationMs: Date.now() - t0,
        tail: `spawn error: ${err.message}`,
        totalJudgeCost: null,
      });
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
