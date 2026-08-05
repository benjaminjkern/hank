// One-off: tidy a day's audit report.
//
// The report appends one run-block per audit. Iterating on a fix re-runs an
// audit several times, so the file accumulates stale/superseded blocks. Two
// cleanup modes:
//
//   # keep only the LATEST block per sub-agent (the usual finishing pass):
//   pnpm exec tsx scripts/regression/sub-agents/clean-report.ts <report.md> --keep-latest
//
//   # drop specific blocks by Run ID (e.g. an interrupted/empty run):
//   pnpm exec tsx scripts/regression/sub-agents/clean-report.ts <report.md> <runId> [runId...]

import { readFile, writeFile } from "fs/promises";

// The "## X" header that names the sub-agent (the one that isn't "Run summary").
function subAgentName(block: string): string | null {
  const heads = [...block.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  return heads.find((h) => h !== "Run summary") ?? null;
}

async function main() {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length === 0) {
    throw new Error(
      "usage: clean-report.ts <report.md> --keep-latest | <runId> [runId...]",
    );
  }
  const text = await readFile(path, "utf-8");

  // Preserve the "# Sub-agent audit report — DATE" title, then split the rest
  // into run-blocks. Blocks are joined by "\n\n---\n\n", but cases can contain
  // internal "---" separators — so only split where the separator is followed
  // by a "Run ID:" line (the start of a real run-block).
  const titleMatch = text.match(/^# Sub-agent audit report[^\n]*\n\n/);
  const title = titleMatch?.[0] ?? "";
  const body = text.slice(title.length);
  const blocks = body.split(/\n\n---\n\n(?=Run ID: `)/);

  let kept: string[];
  if (rest[0] === "--keep-latest") {
    // Keep only the last block per sub-agent (preserving first-seen order).
    const lastIdx = new Map<string, number>();
    blocks.forEach((b, i) => {
      const name = subAgentName(b);
      if (name) lastIdx.set(name, i);
    });
    const keepIdx = new Set(lastIdx.values());
    kept = blocks.filter((_, i) => keepIdx.has(i));
    const dropped = blocks.length - kept.length;
    process.stdout.write(
      `✓ keep-latest: kept ${kept.length} block(s) (one per sub-agent), dropped ${dropped} superseded.\n`,
    );
    for (const [name, i] of lastIdx) {
      const id = blocks[i].match(/Run ID: `([^`]+)`/)?.[1] ?? "?";
      process.stdout.write(`  - ${name}: ${id}\n`);
    }
  } else {
    const staleIds = rest;
    kept = [];
    let dropped = 0;
    for (const b of blocks) {
      const id = b.match(/Run ID: `([^`]+)`/)?.[1] ?? "";
      if (staleIds.includes(id)) {
        dropped++;
        process.stdout.write(`  dropped stale block: ${id}\n`);
        continue;
      }
      kept.push(b);
    }
    if (dropped === 0) {
      process.stdout.write(
        "No matching stale blocks found — nothing changed.\n",
      );
      return;
    }
    process.stdout.write(`✓ dropped ${dropped} block(s) by Run ID.\n`);
  }

  await writeFile(path, title + kept.join("\n\n---\n\n"), "utf-8");
  process.stdout.write(`Wrote ${path}.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
