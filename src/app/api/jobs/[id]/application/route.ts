// The application page: read it, add / reword / remove a question the form asks
// for, and write one item's text.
//
// One item per request, addressed by the same id the agent's tools use
// (`cover_letter` or a `q_…`), so the panel and `draft_application_question`
// name the same thing. Writes persist immediately — the page is DB truth, and a
// refresh or a second device sees it — but never wake Hank: the edit rides the
// user's next message via the panel-edit relay.
//
// Every handler that writes returns the fresh view, so the panel never has to
// guess what the write did to the rest of the form.

import { z } from "zod";

import {
  addUserQuestion,
  removeUserQuestion,
  renameUserQuestion,
  resolveQuestionId,
} from "@/server/entities/jobs/applicationQuestions";
import { editApplicationItem } from "@/server/entities/jobs/editApplicationItem";
import {
  rejectImpersonatedWrite,
  resolveViewedUser,
} from "@/server/platform/admin/viewerScope";
import { getCurrentUser } from "@/server/platform/auth/currentUser";
import { loadApplicationView } from "@/server/views/application";

export const dynamic = "force-dynamic";

const EditItemSchema = z.object({
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

// Reword a question this user added by hand. `itemId` addresses the existing
// one; `question` is its new wording.
const RenameQuestionSchema = z.object({
  itemId: z.string(),
  question: z.string().trim().min(1).max(2000),
});

// Remove a question this user added by hand — `itemId` addresses it.
const RemoveQuestionSchema = z.object({ itemId: z.string() });

// The response every handler ends on: the page as it now stands.
async function applicationViewResponse(
  userId: string,
  jobId: string,
): Promise<Response> {
  const view = await loadApplicationView(userId, jobId);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(view);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { viewedUserId } = await resolveViewedUser(req);
  const { id: jobId } = await params;
  return await applicationViewResponse(viewedUserId, jobId);
}

// Add a question the scrape missed. The question lands on the JOB (global,
// shared with every user of the posting) carrying who added it and when, which
// is what lets the panel badge it as described-by-hand rather than read off the
// form.
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

  return await applicationViewResponse(user.id, jobId);
}

// Reword a hand-added question. Separate from PATCH because it isn't an edit to
// an answer — it changes the KEY every answer is stored under, so it moves the
// saved answer, Hank's baseline, and the cached verdict with it.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const { id: jobId } = await params;

  const parsed = RenameQuestionSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }

  const resolved = await resolveQuestionId(jobId, parsed.data.itemId);
  if (resolved?.kind !== "question") {
    return Response.json({ error: "unknown item" }, { status: 404 });
  }

  const renamed = await renameUserQuestion(
    user.id,
    jobId,
    resolved.text,
    parsed.data.question.trim(),
  );
  if (!renamed.ok) {
    // "not_yours" is a 403 rather than a 404: the question exists and is
    // visible, it just isn't this user's wording to change.
    const status = renamed.reason === "not_yours" ? 403 : 404;
    return Response.json({ error: renamed.reason }, { status });
  }

  return await applicationViewResponse(user.id, jobId);
}

// Take back a hand-added question. Separate from a PATCH that blanks the text:
// that clears the ANSWER and leaves the form still asking, which is right for a
// question the form really asks and wrong for one that was never there.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id: jobId } = await params;

  const parsed = RemoveQuestionSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }

  const resolved = await resolveQuestionId(jobId, parsed.data.itemId);
  if (resolved?.kind !== "question") {
    return Response.json({ error: "unknown item" }, { status: 404 });
  }

  const removed = await removeUserQuestion(user.id, jobId, resolved.text);
  if (!removed.ok) {
    const status = removed.reason === "not_yours" ? 403 : 404;
    return Response.json({ error: removed.reason }, { status });
  }

  return await applicationViewResponse(user.id, jobId);
}

// Write one item's text and/or its reuse switch.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id: jobId } = await params;

  const parsed = EditItemSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }

  const edited = await editApplicationItem(user.id, jobId, parsed.data);
  if (!edited.ok) {
    const error =
      edited.reason === "unknown_item" ? "unknown item" : "not found";
    return Response.json({ error }, { status: 404 });
  }

  return await applicationViewResponse(user.id, jobId);
}
