// The application page: read it, add a question the form asks for, and write
// one item's text.
//
// One item per request, addressed by the same id the agent's tools use
// (`cover_letter` or a `q_…`), so the panel and `draft_application_question`
// name the same thing. Writes persist immediately — the page is DB truth, and a
// refresh or a second device sees it — but never wake Hank: the edit rides the
// user's next message via the panel-edit relay.
//
// Every handler that writes returns the fresh view, so the panel never has to
// guess what the write did to the rest of the form.
//
// Editing sets the item's "ok to reuse when drafting" flag, since the user
// actively working the text is exactly what makes it theirs. Only the touched
// item flips; an explicit `reuse` in the same request (the switch itself) wins.

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { getCurrentUser } from "@/server/auth/currentUser";
import {
  rejectImpersonatedWrite,
  resolveViewedUser,
} from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import {
  readReuseFlags,
  readShortAnswers,
} from "@/server/entities/jobs/applicationDrafts";
import {
  COVER_LETTER_ID,
  questionId,
} from "@/server/entities/jobs/applicationItemId";
import {
  addUserQuestion,
  resolveQuestionId,
} from "@/server/entities/jobs/applicationQuestions";
import { loadApplicationView } from "@/server/views/application";
import { normalizeForCompare } from "@/utils/text";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // "cover_letter" or a questionId from the view.
  itemId: z.string(),
  // The full new text. Empty string clears the item.
  text: z.string().optional(),
  // The reuse switch, when that's what was toggled.
  reuse: z.boolean().optional(),
});

const AddQuestionSchema = z.object({
  // The question exactly as the form asks it — it's the matching key for every
  // answer saved against it.
  question: z.string().trim().min(1).max(2000),
  questionType: z.string().max(64).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id: jobId } = await params;
  const view = await loadApplicationView(viewedUserId, jobId);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(view);
}

// Add a question the scrape missed. The question lands on the JOB (global,
// shared with every user of the posting) carrying who added it and when, which
// is what lets the panel badge it as described-by-hand rather than read off the
// form. `addUserQuestion` also clears this user's cached decision so the new
// question is included the next time anything drafts.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id: jobId } = await params;

  const parsed = AddQuestionSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }

  const added = await addUserQuestion(
    user.id,
    jobId,
    parsed.data.question.trim(),
    parsed.data.questionType,
  );
  if (!added.ok) return Response.json({ error: "not found" }, { status: 404 });

  const view = await loadApplicationView(user.id, jobId);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(view);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id: jobId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  const { itemId, text, reuse } = parsed.data;

  const existing = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: user.id, jobId } },
    select: { coverLetter: true, shortAnswers: true, shortAnswersReuse: true },
  });
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  const data: Prisma.JobInteractionUpdateInput = {};

  if (itemId === COVER_LETTER_ID) {
    if (text !== undefined) {
      const next = text.trim().length > 0 ? text : null;
      data.coverLetter = next;
      // Clearing an item leaves reuse alone — there's nothing to reuse, and the
      // next edit re-sets it.
      if (next !== null && next !== existing.coverLetter) {
        data.coverLetterReuse = true;
      }
    }
    if (reuse !== undefined) data.coverLetterReuse = reuse;
  } else {
    // The id resolves through the merged form so a question the panel showed
    // maps to the exact text the answer is keyed by.
    const resolved = await resolveQuestionId(jobId, itemId);
    const answers = readShortAnswers(existing.shortAnswers);
    const flags = readReuseFlags(existing.shortAnswersReuse);
    while (flags.length < answers.length) flags.push(null);

    // An id that no longer resolves against the form can still match an answer
    // already saved under it — the form changed, the answer didn't.
    const question =
      resolved?.kind === "question"
        ? resolved.text
        : answers.find((a) => questionId(a.question) === itemId)?.question;
    if (!question) {
      return Response.json({ error: "unknown item" }, { status: 404 });
    }
    const norm = normalizeForCompare(question);
    const idx = answers.findIndex(
      (a) => normalizeForCompare(a.question) === norm,
    );

    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        if (idx >= 0) {
          answers.splice(idx, 1);
          flags.splice(idx, 1);
        }
      } else if (idx >= 0) {
        if (answers[idx].answer !== text) flags[idx] = true;
        answers[idx] = { question, answer: text };
      } else {
        answers.push({ question, answer: text });
        flags.push(true);
      }
      data.shortAnswers = answers;
      data.shortAnswersReuse = flags;
    }
    if (reuse !== undefined && idx >= 0) {
      flags[idx] = reuse;
      data.shortAnswersReuse = flags;
    }
  }

  // proposedDrafts is deliberately NOT touched here: the whole point is that
  // this write diverges from what Hank last wrote, which is what makes the edit
  // visible to the relay.
  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId: user.id, jobId } },
    data,
    select: { id: true },
  });

  const view = await loadApplicationView(user.id, jobId);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(view);
}
