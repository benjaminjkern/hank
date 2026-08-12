// Critique-and-revise loop — the path the walkthrough job arm runs AFTER
// drafting an application's answers (via runApplicationDrafting).
//
// Flow: load the current persisted form (cover letter + short answers) →
// the critic sub-agent reviews the WHOLE form as a recruiter would → every
// issue it can act on is redrafted with the critique attached → persist →
// re-critique. It normally stops because a round changed nothing, not because
// it ran out of rounds.
//
// TWO filters decide what it acts on, and everything it declines lands in
// `unresolvedIssues` rather than disappearing:
//   - whose words are these — anything the user wrote or reworked (isUserOwned)
//     is reported and left alone. Rewriting a person's own sentences because a
//     reviewer disliked them is the one thing this loop must never do.
//   - could a rewrite settle it — an `ask_user` issue turns on a fact only the
//     candidate has, so redrafting hands back the same objection next round.
//
// Any revision it does make is a Hank overwrite, so it clears that item's reuse
// flag and moves his baseline.

import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import {
  DRAFTED_ROW_SELECT,
  isUserOwned,
  readShortAnswers,
  type ApplicationItemRef,
  type DraftedRow,
} from "@/server/entities/jobs/applicationDrafts";
import { isCoverLetterTarget } from "@/server/entities/jobs/applicationItemId";
import { persistApplicationAnswer } from "@/server/entities/jobs/applicationQuestions";
import { openTraceSpan } from "@/server/platform/trace/span";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  applicationCriticSubAgent,
  type CritiqueIssue,
} from "@/server/subagents/registry/applicationCritic";
import { normalizeForCompare } from "@/utils/text";

import { draftSingleApplicationItem } from "./draftSingleApplicationItem";
import { loadApplicationCriticInput } from "./loadApplicationCriticInput";

// The loop stops on its own as soon as a round fixes nothing new, so this is a
// runaway backstop rather than the usual exit — set it high enough that a
// fixable problem never reaches the user just because the counter ran out.
const MAX_REVISION_ROUNDS = 5;

type CritiqueLoopEvent =
  { type: "progress"; label: string } | { type: "revised"; target: string };

// Why the loop stopped. It is the honest answer to "did it finish, or give up?"
// — the question the user is left with when a draft arrives and nothing says
// which happened. `needs_user` is the ordinary ending: a pass found things only
// the candidate can settle, so there is nothing left to rewrite.
export type CritiqueStop =
  // A pass read the whole form and raised nothing.
  | "clean"
  // What's left turns on a fact only the user has, or is their own writing.
  | "needs_user"
  // Ran out of revision rounds with fixable problems still open.
  | "capped"
  // A round produced no revision at all (every redraft call failed).
  | "stalled"
  // A pass couldn't run.
  | "error";

export type CritiqueLoopResult = {
  // false when there was nothing to review (empty form) — the critic never ran.
  ran: boolean;
  critiqueRounds: number;
  revisionRounds: number;
  stop: CritiqueStop;
  // Human-facing labels of the items actually re-drafted ("cover_letter" or the
  // question text).
  revisedTargets: string[];
  // Issues still open when the loop stopped (empty on a clean finish).
  unresolvedIssues: CritiqueIssue[];
  // The last pass's one-line word to the candidate — what the runner says when
  // it puts the application on screen. Empty when no pass produced one.
  note: string;
};

type CritiqueLoopArgs = RunContext & {
  jobId: string;
  sessionId: string;
};

type FormState = {
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
  // The authorship columns, so the loop can tell Hank's drafts from the user's
  // own text without a second read.
  row: DraftedRow;
};

type ResolvedItem =
  | { kind: "cover"; priorDraft: string }
  | {
      kind: "short";
      index: number;
      question: string;
      priorDraft: string;
    };

export async function* critiqueAndReviseForm(
  outerArgs: CritiqueLoopArgs,
): AsyncGenerator<CritiqueLoopEvent, CritiqueLoopResult> {
  // A generator can't be wrapped by withTraceSpan (the wrapper would have to
  // drain it eagerly), so the span is opened explicitly and closed in a finally
  // — which also covers the consumer abandoning the generator early.
  const span = openTraceSpan("critique_and_revise", outerArgs.trace);
  try {
    return yield* critiqueAndRevise({ ...outerArgs, trace: span.trace });
  } finally {
    span.close();
  }
}

async function* critiqueAndRevise(
  args: CritiqueLoopArgs,
): AsyncGenerator<CritiqueLoopEvent, CritiqueLoopResult> {
  const form = await loadForm(args.userId, args.jobId);
  const hasCover = !!form.coverLetter && form.coverLetter.trim().length > 0;
  const hasAnswers = form.shortAnswers.some((a) => a.answer.trim().length > 0);
  if (!hasCover && !hasAnswers) {
    return {
      ran: false,
      critiqueRounds: 0,
      revisionRounds: 0,
      stop: "clean",
      revisedTargets: [],
      unresolvedIssues: [],
      note: "",
    };
  }

  const revised = new Set<string>();
  let critiqueRounds = 0;
  let revisionRounds = 0;
  let stop: CritiqueStop = "clean";
  let unresolved: CritiqueIssue[] = [];
  let note = "";

  while (true) {
    yield {
      type: "progress",
      label: "Reviewing the application for accuracy and consistency…",
    };
    // eslint-disable-next-line no-await-in-loop -- each round critiques the revision the previous round produced
    const context = await loadApplicationCriticInput({
      userId: args.userId,
      jobId: args.jobId,
      coverLetter: form.coverLetter,
      shortAnswers: form.shortAnswers,
    });
    if (!context.ok) {
      stop = "error";
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- same round: the critic reads what the loop above just assembled
    const crit = await runSubAgent(
      applicationCriticSubAgent,
      context.input,
      args,
    );
    if (!crit.ok) {
      stop = "error";
      break;
    }
    critiqueRounds++;
    // Each round's note replaces the last: the final one describes the text
    // that actually ends up on the page.
    note = crit.output.note;
    // No issues IS the clean verdict — the critic reports nothing else.
    if (crit.output.issues.length === 0) {
      stop = "clean";
      unresolved = [];
      break;
    }
    unresolved = crit.output.issues;
    if (revisionRounds >= MAX_REVISION_ROUNDS) {
      stop = "capped";
      break;
    }

    // Resolve each flagged target to a revisable item, collecting the notes that
    // target it. Unmatched targets drop out.
    const byItem = new Map<string, { item: ResolvedItem; notes: string[] }>();
    for (const issue of crit.output.issues) {
      for (const t of issue.targets) {
        const item = resolveTarget(t, form);
        if (!item) continue;
        // Hands off anything the user wrote or reworked. The critique still
        // stands and still surfaces in `unresolvedIssues` — it just isn't
        // acted on by rewriting their words for them.
        if (isUserOwned(form.row, itemRef(item))) continue;
        // And anything a rewrite can't settle: the answer turns on something
        // only the user knows, so redrafting produces the same objection next
        // round. Spending a round on it is how the loop used to hit its cap
        // with fixable problems still untouched.
        if (issue.resolution === "ask_user") continue;
        const key = item.kind === "cover" ? "cover" : `sa:${item.index}`;
        const entry = byItem.get(key) ?? { item, notes: [] };
        entry.notes.push(issue.writerNote);
        byItem.set(key, entry);
      }
    }
    if (byItem.size === 0) {
      stop = "needs_user"; // nothing we're allowed / able to revise
      break;
    }

    let anyRevised = false;
    for (const { item, notes } of byItem.values()) {
      const label = item.kind === "cover" ? "cover letter" : "short answer";
      yield {
        type: "progress",
        label: `Revising the ${label} to address the review…`,
      };
      // eslint-disable-next-line no-await-in-loop -- each item's revision is shown the items already revised (renderOtherItems reads the live form)
      const r = await draftSingleApplicationItem({
        jobId: args.jobId,
        userId: args.userId,
        sessionId: args.sessionId,
        item:
          item.kind === "cover"
            ? { kind: "cover_letter" }
            : { kind: "question", text: item.question },
        revision: {
          priorDraft: item.priorDraft,
          critique: notes.map((n) => `- ${n}`).join("\n"),
          formContext: renderOtherItems(form, item),
        },
        trace: args.trace,
      });
      if (r.ok) {
        applyRevision(form, item, r.content);
        // eslint-disable-next-line no-await-in-loop -- persists the revision the line above produced
        await persistApplicationAnswer(
          args.userId,
          args.jobId,
          item.kind === "cover"
            ? { coverLetter: r.content, author: "hank" }
            : { question: item.question, answer: r.content, author: "hank" },
        );
        const tgt = item.kind === "cover" ? "cover_letter" : item.question;
        revised.add(tgt);
        anyRevised = true;
        yield { type: "revised", target: tgt };
      }
    }
    if (!anyRevised) {
      stop = "stalled"; // every redraft failed — don't spin on it
      break;
    }
    revisionRounds++;
  }

  return {
    ran: true,
    critiqueRounds,
    revisionRounds,
    stop,
    revisedTargets: [...revised],
    unresolvedIssues: unresolved,
    note,
  };
}

async function loadForm(userId: string, jobId: string): Promise<FormState> {
  const ji = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: DRAFTED_ROW_SELECT,
  });
  const row: DraftedRow = ji ?? {
    coverLetter: null,
    coverLetterReuse: null,
    shortAnswers: null,
    shortAnswersReuse: null,
    proposedDrafts: null,
    relayedDrafts: null,
  };
  return {
    coverLetter: row.coverLetter,
    shortAnswers: readShortAnswers(row.shortAnswers),
    row,
  };
}

// Match a critic-supplied target ("cover_letter" or a question string) to an
// item in the current form. Exact normalized question match first, then a
// substring match either direction (the critic may paraphrase slightly).
function resolveTarget(target: string, form: FormState): ResolvedItem | null {
  const norm = normalizeForCompare(target);
  if (isCoverLetterTarget(target)) {
    if (!form.coverLetter?.trim()) return null;
    return {
      kind: "cover",
      priorDraft: form.coverLetter,
    };
  }
  let idx = form.shortAnswers.findIndex(
    (a) => normalizeForCompare(a.question) === norm,
  );
  if (idx < 0 && norm.length > 12) {
    idx = form.shortAnswers.findIndex((a) => {
      const q = normalizeForCompare(a.question);
      return q.length > 12 && (q.includes(norm) || norm.includes(q));
    });
  }
  if (idx < 0) return null;
  const a = form.shortAnswers[idx];
  if (!a.answer.trim()) return null;
  return {
    kind: "short",
    index: idx,
    question: a.question,
    priorDraft: a.answer,
  };
}

// The rest of the application (everything except the item being revised), so a
// revision doesn't reintroduce a contradiction with a sibling answer.
function renderOtherItems(form: FormState, item: ResolvedItem): string {
  const parts: string[] = [];
  if (item.kind !== "cover" && form.coverLetter?.trim()) {
    parts.push(`Cover letter:\n${form.coverLetter.trim()}`);
  }
  form.shortAnswers.forEach((a, i) => {
    if (item.kind === "short" && i === item.index) return;
    if (!a.answer.trim()) return;
    parts.push(`Q: ${a.question}\nA: ${a.answer.trim()}`);
  });
  return parts.join("\n\n");
}

function itemRef(item: ResolvedItem): ApplicationItemRef {
  return item.kind === "cover"
    ? { kind: "cover_letter" }
    : { kind: "question", question: item.question };
}

function applyRevision(
  form: FormState,
  item: ResolvedItem,
  content: string,
): void {
  if (item.kind === "cover") {
    form.coverLetter = content;
  } else {
    form.shortAnswers[item.index] = {
      ...form.shortAnswers[item.index],
      answer: content,
    };
  }
}
