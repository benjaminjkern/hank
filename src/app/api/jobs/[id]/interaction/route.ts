import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import type { ShortAnswer } from "@/server/agent/tools/lib/types";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { updateJobInteraction } from "@/server/entities/jobs/updateJobInteraction";
import { getFocusedJobView } from "@/server/views/getFocusedJob";

export const dynamic = "force-dynamic";

// Client-facing edit path for cover letters + short answers. Mirrors the
// agent's `update_job_interaction`, but ALSO turns on the "ok to reuse this when
// drafting" flag for whatever the user just edited — the one signal separating
// text the user owns from a draft Hank wrote.
const BodySchema = z.object({
  coverLetter: z.string().nullable().optional(),
  shortAnswers: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .nullable()
    .optional(),
  // "Keep in my profile" reuse toggles — the switch itself, which always wins
  // over the edit-driven default computed below.
  coverLetterReuse: z.boolean().optional(),
  shortAnswersReuse: z.array(z.boolean().nullable()).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  // Read existing state for the diff. Diffing against "as-currently-stored"
  // gives us a stable signal of what the user actually changed — an agent
  // first-write doesn't stamp because the agent goes through
  // updateJobInteraction directly, not this route.
  const existing = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: user.id, jobId: id } },
    select: {
      coverLetter: true,
      shortAnswers: true,
      shortAnswersReuse: true,
    },
  });

  // Use undefined to mean "no change", null to mean "clear", an array to set.
  // The persistence step below maps these onto Prisma's update payload.
  //
  // Auto reuse: editing or adding an artifact turns its "use when drafting"
  // switch on (the user is actively working it). Only the *changed* rows flip —
  // untouched rows keep their existing reuse value, so an explicit off the user
  // set on a different row survives a neighboring edit. An explicit reuse param
  // in the same request (the switch itself) always wins over this default.
  let autoCoverLetterReuse: boolean | undefined;
  let autoShortAnswersReuse: (boolean | null)[] | null | undefined;

  if (parsed.data.coverLetter !== undefined) {
    const oldCL = existing?.coverLetter ?? null;
    const newCL = parsed.data.coverLetter ?? null;
    // Removing the draft leaves reuse alone — there's no artifact to reuse, and
    // a future edit re-sets it.
    if (oldCL !== newCL && newCL !== null) autoCoverLetterReuse = true;
  }

  if (parsed.data.shortAnswers !== undefined) {
    const oldArr = (existing?.shortAnswers as ShortAnswer[] | null) ?? [];
    const oldReuse =
      (existing?.shortAnswersReuse as (boolean | null)[] | null) ?? [];
    const newArr = parsed.data.shortAnswers;
    if (newArr === null) {
      // User cleared all short answers — clear the parallel reuse array too.
      autoShortAnswersReuse = null;
    } else {
      autoShortAnswersReuse = newArr.map((qa, i) => {
        const old = oldArr[i];
        // Unchanged row keeps its reuse value; changed / added → reuse on.
        const unchanged =
          old && old.question === qa.question && old.answer === qa.answer;
        return unchanged ? (oldReuse[i] ?? null) : true;
      });
    }
  }

  const hasContentUpdate =
    parsed.data.coverLetter !== undefined ||
    parsed.data.shortAnswers !== undefined;
  const hasReuseUpdate =
    parsed.data.coverLetterReuse !== undefined ||
    parsed.data.shortAnswersReuse !== undefined;

  if (!hasContentUpdate && !hasReuseUpdate) {
    return Response.json({ error: "no fields to update" }, { status: 400 });
  }

  // Reuse-only patches act on an existing artifact — the row must already
  // exist (you can only toggle reuse on an answer that's there).
  if (!hasContentUpdate && hasReuseUpdate && !existing) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (hasContentUpdate) {
    const applied = await updateJobInteraction(user.id, id, {
      coverLetter: parsed.data.coverLetter,
      shortAnswers: parsed.data.shortAnswers,
    });
    if (applied.length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 400 });
    }
  }

  // Explicit reuse params (the switch) win; otherwise apply the edit-driven
  // auto-reuse computed above.
  const postData: Prisma.JobInteractionUncheckedUpdateInput = {};
  if (parsed.data.coverLetterReuse !== undefined) {
    postData.coverLetterReuse = parsed.data.coverLetterReuse;
  } else if (autoCoverLetterReuse !== undefined) {
    postData.coverLetterReuse = autoCoverLetterReuse;
  }
  if (parsed.data.shortAnswersReuse !== undefined) {
    postData.shortAnswersReuse =
      parsed.data.shortAnswersReuse === null
        ? Prisma.JsonNull
        : parsed.data.shortAnswersReuse;
  } else if (autoShortAnswersReuse !== undefined) {
    postData.shortAnswersReuse =
      autoShortAnswersReuse === null ? Prisma.JsonNull : autoShortAnswersReuse;
  }
  if (Object.keys(postData).length > 0) {
    await prisma.jobInteraction.update({
      where: { userId_jobId: { userId: user.id, jobId: id } },
      data: postData,
    });
  }

  const job = await getFocusedJobView(user.id, id);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(job);
}
