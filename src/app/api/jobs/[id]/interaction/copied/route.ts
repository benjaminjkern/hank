import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import type { ShortAnswer } from "@/server/agent/tools/lib/types";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { getFocusedJobView } from "@/server/views/getFocusedJob";

export const dynamic = "force-dynamic";

// Mark a draft artifact as copied by the user. Used by the side panel's Copy
// buttons: copying without editing is still a clear signal the user wants this
// artifact reused, so it turns the "use when drafting" switch on (they can
// toggle it back off). Returns the refreshed job view so the client flips the
// switch immediately.
const BodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cover_letter") }),
  z.object({
    kind: z.literal("short_answer"),
    index: z.number().int().nonnegative(),
  }),
]);

export async function POST(
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

  const jobInteraction = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId: user.id, jobId: id } },
    select: {
      id: true,
      shortAnswers: true,
      shortAnswersReuse: true,
    },
  });
  if (!jobInteraction) {
    return Response.json({ error: "no job interaction" }, { status: 404 });
  }

  const updates: Prisma.JobInteractionUncheckedUpdateInput = {};

  if (parsed.data.kind === "cover_letter") {
    updates.coverLetterReuse = true;
  } else {
    const { index } = parsed.data;
    const arr = (jobInteraction.shortAnswers as ShortAnswer[] | null) ?? [];
    if (index >= arr.length) {
      return Response.json({ error: "index out of range" }, { status: 400 });
    }
    // Turn the reuse switch on for the copied row; preserve every other row's
    // existing value.
    const existingReuse =
      (jobInteraction.shortAnswersReuse as (boolean | null)[] | null) ?? [];
    const nextReuse = arr.map((_, i) =>
      i === index ? true : (existingReuse[i] ?? null),
    );
    updates.shortAnswersReuse = nextReuse;
  }

  await prisma.jobInteraction.update({
    where: { id: jobInteraction.id },
    data: updates,
  });

  const job = await getFocusedJobView(user.id, id);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(job);
}
