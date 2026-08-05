import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client";
import { costOf } from "../../src/server/platform/usage/pricing";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function pad(s: string, n: number) {
  return s.padEnd(n).slice(0, n);
}
function num(n: number) {
  return n.toLocaleString();
}
function money(d: number) {
  return `$${d.toFixed(4)}`;
}

async function main() {
  const rows = await prisma.tokenUsage.findMany({
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log("(no usage rows yet)");
    return;
  }

  // Aggregate by (operation, model) so per-model rates apply correctly.
  // Sonnet-priced chat and Haiku-priced compact_chat should not be averaged.
  type Agg = {
    calls: number;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    webSearch: number;
    cost: number;
  };
  const byOpModel = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.operation}|${r.model}`;
    let a = byOpModel.get(key);
    if (!a) {
      a = {
        calls: 0,
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        webSearch: 0,
        cost: 0,
      };
      byOpModel.set(key, a);
    }
    a.calls += 1;
    a.input += r.inputTokens;
    a.output += r.outputTokens;
    a.cacheCreate += r.cacheCreationInputTokens;
    a.cacheRead += r.cacheReadInputTokens;
    a.webSearch += r.webSearchRequests;
    a.cost += costOf(r);
  }

  console.log("By operation × model:");
  console.log(
    pad("operation", 14) +
      pad("model", 22) +
      pad("calls", 8) +
      pad("input", 12) +
      pad("output", 10) +
      pad("cache_w", 12) +
      pad("cache_r", 12) +
      pad("web_search", 12) +
      "cost",
  );
  let totalCost = 0;
  for (const [key, a] of byOpModel) {
    const [op, model] = key.split("|");
    totalCost += a.cost;
    console.log(
      pad(op, 14) +
        pad(model, 22) +
        pad(num(a.calls), 8) +
        pad(num(a.input), 12) +
        pad(num(a.output), 10) +
        pad(num(a.cacheCreate), 12) +
        pad(num(a.cacheRead), 12) +
        pad(num(a.webSearch), 12) +
        money(a.cost),
    );
  }
  console.log("");
  console.log(`Total estimated cost: ${money(totalCost)}`);
  console.log("");

  // Per-tool breakdown (only meaningful once toolName has been populated; older
  // rows show up under "(null)"). Sub-agent turns that only emitted their output
  // schema are deliberately "(null)" too — that is not a tool call. Attribute
  // sub-agent spend with the by-operation table above, not this one.
  const byTool = new Map<string, { calls: number; cost: number }>();
  for (const r of rows) {
    const key = r.toolName ?? "(null)";
    const a = byTool.get(key) ?? { calls: 0, cost: 0 };
    a.calls += 1;
    a.cost += costOf(r);
    byTool.set(key, a);
  }
  const sortedTools = [...byTool.entries()].sort(
    (a, b) => b[1].cost - a[1].cost,
  );
  console.log("By primary tool (first tool_use block in the reply):");
  console.log(pad("tool", 32) + pad("calls", 8) + "cost");
  for (const [tool, a] of sortedTools) {
    console.log(pad(tool, 32) + pad(num(a.calls), 8) + money(a.cost));
  }
  console.log("");

  // Latest 10 rows
  const latest = rows.slice(-10).reverse();
  console.log("Latest 10 calls:");
  console.log(
    pad("when", 22) +
      pad("op", 14) +
      pad("tool", 22) +
      pad("in", 9) +
      pad("out", 7) +
      pad("c_w", 9) +
      pad("c_r", 9) +
      "notes",
  );
  for (const r of latest) {
    console.log(
      pad(r.createdAt.toISOString().slice(0, 19), 22) +
        pad(r.operation, 14) +
        pad(r.toolName ?? "-", 22) +
        pad(num(r.inputTokens), 9) +
        pad(num(r.outputTokens), 7) +
        pad(num(r.cacheCreationInputTokens), 9) +
        pad(num(r.cacheReadInputTokens), 9) +
        (r.notes ?? "").slice(0, 60),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
