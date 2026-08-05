// Critique-and-revise loop — the path the walkthrough job arm runs AFTER
// drafting an application's answers (via runApplicationDrafting).
//
// Flow: load the current persisted form (cover letter + short answers) →
// The critic sub-agent reviews the WHOLE form as a recruiter would → for every
// item the critic flags, re-call runApplicationDrafting with the critique so it
// revises that item → persist → re-critique. Loop until the critic returns
// clean or we hit MAX_REVISION_ROUNDS (whichever first). "Cap 2" = at most two
// revision rounds; a confirming critique runs after each round, so a form that
// goes clean is reported clean and one that doesn't files an admin note.
//
// The critic reviews the whole form but only REVISES what Hank still owns:
// anything the user has written or reworked (isUserOwned) is reported and left
// alone. Rewriting a person's own sentences because a reviewer disliked them is
// the one thing this loop must never do. Any revision it does make is a Hank
// overwrite, so it flips that item's reuse flag to false and re-baselines it.

import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import {
  DRAFTED_ROW_SELECT,
  isUserOwned,
  readShortAnswers,
  type ApplicationItemRef,
  type DraftedRow,
} from "@/server/entities/jobs/applicationDrafts";
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

const MAX_REVISION_ROUNDS = 2;

type CritiqueLoopEvent =
  { type: "progress"; label: string } | { type: "revised"; target: string };

type CritiqueLoopResult = {
  // false when there was nothing to review (empty form) — the critic never ran.
  ran: boolean;
  critiqueRounds: number;
  revisionRounds: number;
  finalVerdict: "clean" | "revise" | "error";
  // Human-facing labels of the items actually re-drafted ("cover_letter" or the
  // question text).
  revisedTargets: string[];
  // Issues still open when the loop stopped (empty on a clean finish).
  unresolvedIssues: CritiqueIssue[];
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
      finalVerdict: "clean",
      revisedTargets: [],
      unresolvedIssues: [],
    };
  }

  const revised = new Set<string>();
  let critiqueRounds = 0;
  let revisionRounds = 0;
  let finalVerdict: "clean" | "revise" | "error" = "clean";
  let unresolved: CritiqueIssue[] = [];

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
      finalVerdict = "error";
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- same round: the critic reads what the loop above just assembled
    const crit = await runSubAgent(
      applicationCriticSubAgent,
      context.input,
      args,
    );
    if (!crit.ok) {
      finalVerdict = "error";
      break;
    }
    critiqueRounds++;
    // No issues IS the clean verdict — the critic reports nothing else.
    if (crit.output.issues.length === 0) {
      finalVerdict = "clean";
      unresolved = [];
      break;
    }
    finalVerdict = "revise";
    unresolved = crit.output.issues;
    if (revisionRounds >= MAX_REVISION_ROUNDS) break;

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
        const key = item.kind === "cover" ? "cover" : `sa:${item.index}`;
        const entry = byItem.get(key) ?? { item, notes: [] };
        entry.notes.push(issue.note);
        byItem.set(key, entry);
      }
    }
    if (byItem.size === 0) break; // nothing we're allowed / able to revise

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
            ? { coverLetter: r.content }
            : { question: item.question, answer: r.content },
        );
        const tgt = item.kind === "cover" ? "cover_letter" : item.question;
        revised.add(tgt);
        anyRevised = true;
        yield { type: "revised", target: tgt };
      }
    }
    if (!anyRevised) break; // couldn't revise anything this round — avoid a spin
    revisionRounds++;
  }

  return {
    ran: true,
    critiqueRounds,
    revisionRounds,
    finalVerdict,
    revisedTargets: [...revised],
    unresolvedIssues: unresolved,
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
  if (norm === "cover_letter" || norm === "cover letter") {
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
