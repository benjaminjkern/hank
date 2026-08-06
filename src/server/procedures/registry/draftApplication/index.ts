// The draft-application procedure — the reusable chain the walkthrough job arm
// runs once a job is being applied to, AND the on-demand engine the
// draft_application tool drives (via runDraftApplicationCollect). Steps (extracted
// from the former runJobArm Steps 4–5.25):
//
//   1. fetch the application form   → ensureApplicationForm (./ensureApplicationForm)
//   2. decide draft/skip/ask_user   → applicationDeciderSubAgent (cached on draftDecision)
//   3. draft the auto-draftable items → runApplicationDrafting
//   4. critique + revise            → critiqueAndReviseForm (./critiqueAndRevise)
//
// It yields ordinary TurnEvents (pipeline_status / text / refresh_viewed_state)
// and RETURNS the outcome the shell (runJobArm) needs to decide the
// co-write hand-off (Step 5.5) and the terminal narration (Step 6). The co-write
// gates + enterCoWrite stay in the shell; co-write re-derives its pending items
// on job re-entry (no persisted marker — focus is ephemeral).
//
// Two triggers: the state machine auto-runs it on job entry (no extraContext);
// the draft_application tool runs it on demand (extraContext = the user's chat
// guidance, forceRedecide to re-run from scratch). Questions = the scraped form
// MERGED with the per-user hand-added overlay (loadMergedQuestions). Every write
// goes through persistApplicationAnswer, the one seam that sets reuse=false (a
// Hank draft isn't reuse-eligible until the user opts it in) and re-baselines
// proposedDrafts so a later panel edit diverges from what he actually wrote.

import type { RunContext, TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import {
  persistApplicationAnswer,
  loadMergedQuestions,
} from "@/server/entities/jobs/applicationQuestions";
import { needsQuestionsRefresh } from "@/server/entities/jobs/questionsRefresh";
import {
  isCoverLetterQuestion,
  isProseQuestion,
  type ApplicationQuestion,
} from "@/server/scrape/types";
import type {
  ApplicationDecision,
  DraftVerdict,
} from "@/server/subagents/registry/applicationDecider";

import { critiqueAndReviseForm } from "./critiqueAndRevise";
import {
  decideApplicationForm,
  decisionCoversForm,
} from "./decideApplicationForm";
import { draftSingleApplicationItem } from "./draftSingleApplicationItem";
import { ensureApplicationForm } from "./ensureApplicationForm";

type DraftApplicationArgs = RunContext & {
  sessionId: string;
  jobId: string;
  // Free-text guidance the user gave in chat about the whole application —
  // threaded to every drafting call this pass. Also forces a fresh decide (the
  // user's input can flip an ask_user item to draftable).
  extraContext?: string;
  // Ignore any cached draftDecision and re-run the decider.
  forceRedecide?: boolean;
};

type DraftApplicationOutcome = {
  // Whether THIS pass did anything user-visible (gates the Step 6 terminal line).
  didWork: boolean;
  // Items the decider flagged as needing the user's own input — non-empty ⇒ the
  // shell hands off to chat co-writing.
  askUserItems: string[];
  // The form couldn't be read (unsupported / error) AND nobody added a question
  // by hand.
  formUnavailable: boolean;
  hasCoverLetter: boolean;
  answersCount: number;
  // "Acme" / "this company" — for the co-write opening.
  companyDisplay: string;
  // Decider help-first notice (soft-hold override), surfaced once.
  notice: string | null;
};

function status(text: string): TurnEvent {
  return { type: "pipeline_status", text };
}

// Fallback when the decider sub-agent errors: mirror the deterministic
// isProseQuestion rule so drafting never hard-fails. No ask_user verdicts.
function fallbackDecision(
  questions: ApplicationQuestion[],
  formWantsCoverLetter: boolean,
): ApplicationDecision {
  return {
    questions: questions
      .filter((q) => !isCoverLetterQuestion(q.question))
      .map((q) => ({
        question: q.question,
        verdict: isProseQuestion(q.type) ? "draft" : "skip",
        reason: "",
      })),
    coverLetter: formWantsCoverLetter
      ? { verdict: "draft" as DraftVerdict, reason: "" }
      : null,
    notice: null,
    decidedAt: new Date().toISOString(),
  };
}

export async function* runDraftApplication(
  args: DraftApplicationArgs,
): AsyncGenerator<TurnEvent, DraftApplicationOutcome> {
  const { jobId } = args;
  let didWork = false;

  // Step 4: ensure the application form is fetched. ensureApplicationForm
  // persists into Job.applicationQuestions; needsQuestionsRefresh gates it.
  const beforeMerged = await loadMergedQuestions(jobId);
  if (needsQuestionsRefresh(beforeMerged.envelope)) {
    didWork = true;
    yield status("Fetching application form…");
    const formRes = await ensureApplicationForm({ jobId });
    if (formRes.status === "not_found") {
      yield { type: "text", text: `no job found for "${jobId}".` };
    }
  }

  // Merge the scraped form with the per-user user-added overlay.
  const merged = await loadMergedQuestions(jobId);
  const nonCoverLetterQuestions = merged.merged.filter(
    (q) => !isCoverLetterQuestion(q.question),
  );
  const hasQuestions = nonCoverLetterQuestions.length > 0;
  const formWantsCoverLetter = merged.formWantsCoverLetter;
  // Step 4 already attempted the fetch above, so a still-null envelope here
  // (formNeverFetched) means it couldn't even try — no application URL on file
  // (a manually-created job). Treat that like an unreadable form so the caller
  // points at the manual path instead of reporting "nothing to draft".
  const formUnavailable = merged.formUnavailable || merged.formNeverFetched;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      companyName: true,
      company: { select: { name: true } },
      jobInteractions: {
        where: { userId: args.userId },
        select: {
          coverLetter: true,
          shortAnswers: true,
          draftDecision: true,
        },
        take: 1,
      },
    },
  });
  const jobInteraction = job?.jobInteractions[0];
  const companyDisplay =
    job?.company?.name ?? job?.companyName ?? "this company";

  // Step 4.5: decide once per job (cached on draftDecision). forceRedecide or
  // fresh extraContext re-runs it — the user's input can flip verdicts.
  const cached =
    args.forceRedecide || args.extraContext?.trim()
      ? null
      : ((jobInteraction?.draftDecision as ApplicationDecision | null) ?? null);
  // A decision that predates a question (hand-added, or turned up by a
  // re-scrape) can't speak for the whole form, so re-run rather than draft
  // against a partial verdict set.
  let decision =
    cached && decisionCoversForm(cached, merged.merged) ? cached : null;
  if (!decision && (hasQuestions || formWantsCoverLetter)) {
    didWork = true;
    yield status(
      "Working out which answers I can draft and which need your input…",
    );
    const dec = await decideApplicationForm({ ...args, jobId });
    if (dec.ok) {
      decision = dec.decision;
      await prisma.jobInteraction.update({
        where: { userId_jobId: { userId: args.userId, jobId } },
        data: { draftDecision: decision },
      });
    } else {
      decision = fallbackDecision(merged.merged, formWantsCoverLetter);
    }
    if (decision?.notice) {
      yield { type: "text", text: decision.notice };
    }
  }

  // Step 5: act on verdicts. Agent drafts persist with reuse FALSE — a Hank
  // draft isn't reuse-eligible until the user opts it in.
  let answers = (
    (jobInteraction?.shortAnswers as Array<{
      question: string;
      answer: string;
    }> | null) ?? []
  ).slice();
  const answeredSet = new Set(answers.map((q) => q.question));
  let hasCoverLetter =
    !!jobInteraction?.coverLetter &&
    jobInteraction.coverLetter.trim().length > 0;
  const askUserItems: string[] = [];
  let draftedSomething = false;

  if (decision?.coverLetter && !hasCoverLetter) {
    if (decision.coverLetter.verdict === "draft") {
      didWork = true;
      yield status("Drafting cover letter…");
      const drafted = await draftSingleApplicationItem({
        ...args,
        jobId,
        item: { kind: "cover_letter" },
      });
      if (drafted.ok) {
        await persistApplicationAnswer(args.userId, jobId, {
          coverLetter: drafted.content,
        });
        hasCoverLetter = true;
        draftedSomething = true;
        yield { type: "refresh_viewed_state" };
      } else {
        yield {
          type: "text",
          text: `Cover-letter drafting failed: ${drafted.error}`,
        };
      }
    } else if (decision.coverLetter.verdict === "ask_user") {
      askUserItems.push("your cover letter");
    }
  }

  for (const qd of decision?.questions ?? []) {
    if (answeredSet.has(qd.question)) continue;
    if (qd.verdict === "draft") {
      didWork = true;
      yield status(
        `Drafting answer to: ${qd.question.slice(0, 80)}${qd.question.length > 80 ? "…" : ""}`,
      );
      // eslint-disable-next-line no-await-in-loop -- each item is drafted against the form the previous items filled in
      const drafted = await draftSingleApplicationItem({
        ...args,
        jobId,
        item: { kind: "question", text: qd.question },
      });
      if (drafted.ok) {
        answers = [
          ...answers,
          { question: qd.question, answer: drafted.content },
        ];
        answeredSet.add(qd.question);
        draftedSomething = true;
        // eslint-disable-next-line no-await-in-loop -- persists what the draft above produced
        await persistApplicationAnswer(args.userId, jobId, {
          question: qd.question,
          answer: drafted.content,
        });
        yield { type: "refresh_viewed_state" };
      } else {
        yield {
          type: "text",
          text: `Drafting failed for "${qd.question.slice(0, 60)}": ${drafted.error}`,
        };
      }
    } else if (qd.verdict === "ask_user") {
      askUserItems.push(qd.question);
    }
    // skip → nothing
  }

  // Step 5.25: recruiter-lens critique + up-to-2 revision rounds when anything
  // was drafted this pass. Best-effort; the loop swallows its own errors.
  if (draftedSomething) {
    for await (const ev of critiqueAndReviseForm({ ...args, jobId })) {
      if (ev.type === "progress") {
        yield status(ev.label);
      } else {
        yield { type: "refresh_viewed_state" };
      }
    }
    const refreshed = await prisma.jobInteraction.findUnique({
      where: { userId_jobId: { userId: args.userId, jobId } },
      select: { coverLetter: true, shortAnswers: true },
    });
    hasCoverLetter =
      !!refreshed?.coverLetter && refreshed.coverLetter.trim().length > 0;
    answers = (
      (refreshed?.shortAnswers as Array<{
        question: string;
        answer: string;
      }> | null) ?? []
    ).slice();
  }

  return {
    didWork,
    askUserItems,
    formUnavailable,
    hasCoverLetter,
    answersCount: answers.length,
    companyDisplay,
    notice: decision?.notice ?? null,
  };
}

// Drive runDraftApplication to completion from a NON-generator caller (the
// draft_application tool): forward status lines via a callback and collect any
// failure text. Returns the structured outcome + notes. refresh_viewed_state
// pings are dropped (tools set affectsViewedState for the end-of-turn refresh).
export async function runDraftApplicationCollect(
  args: DraftApplicationArgs,
  onStatus?: (label: string) => void,
): Promise<{ result: DraftApplicationOutcome; notes: string[] }> {
  const gen = runDraftApplication(args);
  const notes: string[] = [];
  let next = await gen.next();
  while (!next.done) {
    const ev = next.value;
    if (ev.type === "pipeline_status") onStatus?.(ev.text);
    else if (ev.type === "text") notes.push(ev.text);
    // eslint-disable-next-line no-await-in-loop -- draining a generator — each step is produced by the previous one
    next = await gen.next();
  }
  return { result: next.value, notes };
}
