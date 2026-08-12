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
import {
  countBoard,
  type BoardCounts,
  type ShortlistBoardView,
} from "@/server/views/shortlistBoard";
import { buildShortlistBoardEvents } from "@/server/views/showEvents";

import { loadShortlistJobsInput } from "./loadShortlistJobsInput";
import { seedBoardStances } from "./seedBoardStances";

export type ShortlistArgs = RunContext & {
  sessionId: string;
  // Free-text steer for this round ("infra roles only", "I really need
  // remote"), forwarded from company_walkthrough's `direction`. Its presence is
  // also the "the user wants a FRESH ranking" signal: the seed re-runs on those
  // terms instead of re-showing the board as it stands.
  direction?: string;
};

function describeSeed(
  proposalNote: string | null,
  counts: BoardCounts,
): string {
  const parts: string[] = [];
  if (proposalNote?.trim()) parts.push(proposalNote.trim());
  const pieces = [
    `${counts.picked} I'd apply to`,
    ...(counts.borderline > 0 ? [`${counts.borderline} worth a look`] : []),
    ...(counts.closing > 0 ? [`${counts.closing} I'd pass on`] : []),
  ];
  parts.push(
    `The board on the right has every role with where I landed and why — ${pieces.join(", ")}. Change anything you disagree with (or tell me and I'll move it), and when it looks right I'll lock it in.`,
  );
  return parts.join("\n\n");
}

// Nothing came out worth applying to. The panel says one line and stops, so the
// explanation lives HERE: what got looked at, why none of it landed, and what
// settling actually does. A user who just watched a company produce nothing is
// owed the reasoning, and chat is the surface with room for it.
//
// Holds are named apart from passes because they mean different things to the
// user: a hold survives the settle, a pass doesn't.
function describeNothingPicked(
  board: ShortlistBoardView,
  counts: BoardCounts,
  proposalNote: string | null,
): string {
  const looked =
    counts.total === 1 ? "the one role" : `all ${counts.total} roles`;
  const lead =
    proposalNote?.trim() ||
    `I went through ${looked} at ${board.companyName} and there's nothing here I'd tell you to apply to right now.`;
  const held =
    counts.borderline > 0
      ? ` ${counts.borderline === 1 ? "One I've held" : `${counts.borderline} I've held`} rather than closed — worth keeping, just not worth an application today.`
      : "";
  return [
    lead,
    `They're all on the right with my reasoning on each, strongest first — including the ones I ruled out early, so you can see what I passed over and why.${held}`,
    `Nothing's closed yet. If I've got one wrong, mark it and I'll pull it back; otherwise settle it and I'll clear them out and keep watching ${board.companyName} for new postings.`,
  ].join("\n\n");
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
  const { picked, borderline } = countBoard(board);
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
    // Nothing survived to rank — but the earlier passes have already stanced
    // everything they ruled out, so the board is on the table either way. From
    // the user's side prescan, scan and shortlist are one step, and where the
    // pool happened to empty must not decide whether they get a screen.
    const stanced = await prisma.jobInteraction.count({
      where: { userId, job: { companyId }, ...onBoardWhere() },
    });
    if (stanced === 0) {
      yield {
        type: "text",
        text: `There's nothing read-and-ready to shortlist here right now.`,
      };
      return;
    }
    await markCompanyShortlisting(companyId, userId);
    const { events, board } = await buildShortlistBoardEvents(
      userId,
      companyId,
    );
    yield* yieldUiEvents(events);
    if (board) {
      const counts = countBoard(board);
      yield {
        type: "text",
        text: describeNothingPicked(board, counts, null),
      };
    }
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

  await seedBoardStances({
    userId,
    companyId,
    candidates: context.input.candidates,
    picks,
  });
  // The board is now open and waiting on the user — the one stretch of a
  // company's life where the next move is theirs, so it says so.
  await markCompanyShortlisting(companyId, userId);

  // Describe the BOARD, not the ranker's own tally: the roles the earlier passes
  // ruled out are on that screen too, and they're what made "1 I'd pass on" sit
  // above a pile of forty.
  const { events, board } = await buildShortlistBoardEvents(userId, companyId);
  yield* yieldUiEvents(events);
  const counts = board
    ? countBoard(board)
    : { picked: 0, borderline: 0, closing: 0, total: 0 };
  // Nothing PICKED is the branch, not nothing kept: a round whose survivors are
  // all holds has produced nothing to work on either, and saying "here's your
  // shortlist" over it is the thing that made an empty round feel like a
  // shrug. Holds get named inside that explanation rather than counted as a
  // result.
  const body =
    board && counts.picked === 0
      ? describeNothingPicked(board, counts, picks.proposalNote)
      : describeSeed(picks.proposalNote, counts);
  const unfinished = describeUnfinished(context.input.candidates, picks);
  yield {
    type: "text",
    text: unfinished ? `${body}\n\n${unfinished}` : body,
  };
}
