// The walkthrough company arm's Step 2 — put the shortlist board on screen.
//
// The board is a persisted negotiation over JobInteraction stance columns: the
// seed writes one stance per pool row, the user edits from the panel, Hank
// edits via update_shortlist_proposal, and commit_shortlist ends it. Nothing
// in here changes a status.
//
// Three entries fall out of state, no persisted step pointer:
//   - a `direction` → fresh seed on those terms (re-ranks committed picks too)
//   - an open negotiation → re-show the board as it stands (free — no LLM, so
//     no re-emit guard is needed)
//   - otherwise → seed the pool

import { statusEvent, yieldUiEvents } from "@/server/agent/contracts";
import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { markCompanyShortlisting } from "@/server/entities/companies/markCompanyStatus";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  shortlistJobsSubAgent,
  type ShortlistCandidate,
  type ShortlistJobsOutput,
} from "@/server/subagents/registry/shortlistJobs";
import type { ShortlistBoardView } from "@/server/views/shortlistBoard";
import { buildShortlistBoardEvents } from "@/server/views/showEvents";

import { loadShortlistJobsInput } from "./loadShortlistJobsInput";
import { seedBoardStances, type SeedTallies } from "./seedBoardStances";

export type ShortlistArgs = RunContext & {
  sessionId: string;
  // Free-text steer for this round ("infra roles only", "I really need
  // remote"), forwarded from company_walkthrough's `direction`. Its presence is
  // also the "the user wants a FRESH ranking" signal: the seed re-runs on those
  // terms instead of re-showing the board as it stands.
  direction?: string;
};

// How many per-role reasons to spell out when every role got a pass. A pool of
// 3 wants them all; a 25-role board passed in one sweep wants the shared reason
// and a tail count, not a wall of text.
const ALL_PASSED_REASON_LINES = 6;

function tierCount(board: ShortlistBoardView, tier: string): number {
  return board.tiers.find((t) => t.tier === tier)?.rows.length ?? 0;
}

// The reply when every role got a pass stance: the ranker's shared top-line,
// then the per-role reasons it wrote. Nothing is closed yet — that's the
// commit's job — so the framing is "here's where I landed", not "I closed them".
function describeAllPassed(
  picks: ShortlistJobsOutput,
  candidates: Array<{ id: string; title: string }>,
  companyDisplayName: string,
): string {
  const n = candidates.length;
  const lead =
    picks.proposalNote?.trim() ||
    `I read ${n === 1 ? "the one role" : `all ${n} roles`} at ${companyDisplayName} — none of them look worth applying to.`;
  const lines = candidates
    .filter((c) => picks.reasons[c.id])
    .slice(0, ALL_PASSED_REASON_LINES)
    .map((c) => `- **${c.title}** — ${picks.reasons[c.id]}`);
  const hidden = n - lines.length;
  if (hidden > 0 && lines.length > 0) {
    lines.push(`- …and ${hidden} more, for the same kind of reason.`);
  }
  const body = lines.length > 0 ? `${lead}\n\n${lines.join("\n")}` : lead;
  return `${body}\n\nThey're all on the board with my reasoning — if you agree I'll clear them out, or point me at any you want a closer look at.`;
}

function describeSeed(
  proposalNote: string | null,
  tallies: SeedTallies,
): string {
  const parts: string[] = [];
  if (proposalNote?.trim()) parts.push(proposalNote.trim());
  const counts = [
    `${tallies.picked} I'd apply to`,
    ...(tallies.borderline > 0 ? [`${tallies.borderline} worth a look`] : []),
    ...(tallies.passed > 0 ? [`${tallies.passed} I'd pass on`] : []),
  ];
  parts.push(
    `The board on the right has every role with where I landed and why — ${counts.join(", ")}. Change anything you disagree with (or tell me and I'll move it), and when it looks right I'll lock it in.`,
  );
  return parts.join("\n\n");
}

// Roles whose application was started and abandoned, called out by name.
//
// Deterministic rather than left to the ranker's prose: WHICH roles those are is
// a fact the pool already carries, and a round that quietly re-ranked one the
// user had committed to — possibly down into the closing pile — is the thing
// this exists to prevent. The ranker's own opinion for each is already on its
// board row; this only guarantees the user is told the history is in play, and
// invites the correction only they can make ("I actually did apply to that").
function describeUnfinished(
  candidates: ShortlistCandidate[],
  picks: ShortlistJobsOutput,
): string | null {
  const started = candidates.filter((c) => c.unfinishedApplication);
  if (started.length === 0) return null;
  const picked = new Set(picks.pickedJobIds);
  const passed = new Set(picks.passedJobIds);
  const lines = started.map((c) => {
    const where = picked.has(c.id)
      ? "still near the top"
      : passed.has(c.id)
        ? "in the closing pile now"
        : "held rather than picked";
    return `- **${c.title}** — ${where}.`;
  });
  return [
    started.length === 1
      ? "One thing before you mark it up: you'd started an application here and never sent it."
      : `One thing before you mark it up: you'd started ${started.length} applications here and never sent them.`,
    ...lines,
    "If you actually applied to any of these, say so and I'll record it — otherwise they're yours to re-decide like anything else on the board.",
  ].join("\n");
}

function describeReshow(board: ShortlistBoardView): string {
  const picked = tierCount(board, "picks");
  const borderline = tierCount(board, "borderline");
  const pieces = [
    `${picked} pick${picked === 1 ? "" : "s"}`,
    ...(borderline > 0 ? [`${borderline} still up in the air`] : []),
  ];
  return `We left the shortlist at ${board.companyName} open — ${pieces.join(" and ")} on the board. Take a look and tell me what to change, or say the word and I'll lock it in.`;
}

export async function* runShortlist(
  args: ShortlistArgs & { companyId: string },
): AsyncGenerator<TurnEvent> {
  // No trace span here on purpose: the deterministic layer runs OUTSIDE a tool
  // dispatch, so there is no parent toolUseId to nest under — a span would
  // no-op. Spans go on procedures reachable from a tool handler.
  const { userId, companyId } = args;

  if (!args.direction) {
    const openCount = await prisma.jobInteraction.count({
      where: { userId, job: { companyId }, ...onBoardWhere() },
    });
    if (openCount > 0) {
      // Also on the re-show, not just the fresh seed: an open board IS the
      // status, however the company got here, and a board that outlives the run
      // that seeded it would otherwise never pick it up.
      await markCompanyShortlisting(companyId, userId);
      const { events, board } = await buildShortlistBoardEvents(
        userId,
        companyId,
      );
      yield* yieldUiEvents(events);
      if (board) yield { type: "text", text: describeReshow(board) };
      return;
    }
  }

  const context = await loadShortlistJobsInput({
    userId,
    companyId,
    extraContext: args.direction,
  });
  if (!context.ok) {
    yield {
      type: "text",
      text: `There's nothing read-and-ready to shortlist here right now.`,
    };
    return;
  }
  const n = context.input.candidates.length;
  yield statusEvent(
    `Weighing ${n} role${n === 1 ? "" : "s"} against your thesis…`,
  );
  const result = await runSubAgent(shortlistJobsSubAgent, context.input, args);
  if (!result.ok) {
    yield { type: "text", text: `Shortlist failed: ${result.error}` };
    return;
  }
  const picks = result.output;

  const tallies = await seedBoardStances({
    userId,
    companyId,
    candidates: context.input.candidates,
    picks,
  });
  // The board is now open and waiting on the user — the one stretch of a
  // company's life where the next move is theirs, so it says so.
  await markCompanyShortlisting(companyId, userId);

  const { events } = await buildShortlistBoardEvents(userId, companyId);
  yield* yieldUiEvents(events);
  const body =
    tallies.picked === 0 && tallies.borderline === 0
      ? describeAllPassed(picks, context.input.candidates, context.companyName)
      : describeSeed(picks.proposalNote, tallies);
  const unfinished = describeUnfinished(context.input.candidates, picks);
  yield {
    type: "text",
    text: unfinished ? `${body}\n\n${unfinished}` : body,
  };
}
