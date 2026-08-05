// Spend accountant. Tracks dollar cost across BOTH sides of a run:
//   - the persona Opus agent's own calls (added directly as usage lands)
//   - Hank's internal pipeline calls (Sonnet / Haiku / web-search), which
//     write their own TokenUsage rows keyed by the ephemeral user — summed
//     from the DB after each turn.
// The total is the gate for the global spend cap; overCap() short-circuits
// the experiment before the next turn / persona.

import type { PrismaClient } from "@/generated/prisma/client";
import { costOf } from "@/server/platform/usage/pricing";

type Usage =
  | {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
      server_tool_use?: { web_search_requests?: number } | null;
    }
  | null
  | undefined;

export class SpendAccountant {
  private personaCost = 0;
  // Hank-side cost is recomputed from the DB (not incremental) so it stays
  // correct even if a turn spawned several sub-agent TokenUsage rows.
  private hankCost = 0;

  constructor(
    private readonly db: PrismaClient,
    private readonly capUsd: number,
  ) {}

  // Fold a persona Opus response's usage into the running total.
  addPersonaUsage(model: string, usage: Usage): void {
    if (!usage) return;
    this.personaCost += costOf({
      model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
    });
  }

  // Recompute Hank-side cost from every TokenUsage row the ephemeral users
  // accumulated this run. Called after each turn and — crucially — BEFORE
  // teardown deletes those rows. Pass all userIds the run has created so far.
  async syncHankCost(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await this.db.tokenUsage.findMany({
      where: {
        userId: { in: userIds },
        operation: { not: "qa_audit_persona" },
      },
      select: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheCreationInputTokens: true,
        cacheReadInputTokens: true,
        webSearchRequests: true,
      },
    });
    this.hankCost = rows.reduce((sum, r) => sum + costOf(r), 0);
  }

  total(): number {
    return this.personaCost + this.hankCost;
  }

  personaTotal(): number {
    return this.personaCost;
  }

  hankTotal(): number {
    return this.hankCost;
  }

  cap(): number {
    return this.capUsd;
  }

  overCap(): boolean {
    return this.total() >= this.capUsd;
  }
}
