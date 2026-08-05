// One board-row edit from the panel. Persists the stance immediately (the
// board is DB truth — a refresh or second device sees it); the relay to Hank is
// derived at the user's NEXT chat message (appendUserMessage snapshots rows
// with proposedBy=USER touched since the previous one). Never wakes Hank.

import { z } from "zod";

import { ProposedBy, ProposedVerdict } from "@/generated/prisma/client";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { runReconsiderJob } from "@/server/procedures/registry/reconsiderJob";
import { loadShortlistBoard } from "@/server/views/shortlistBoard";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobId: z.string(),
  // "undecided" is the un-select — the user clearing their own (or Hank's)
  // mark rather than replacing it.
  verdict: z.enum(["pick", "borderline", "pass", "undecided"]),
  reason: z.string().optional(),
});

const VERDICT_FOR = {
  pick: ProposedVerdict.PICK,
  borderline: ProposedVerdict.BORDERLINE,
  pass: ProposedVerdict.PASS,
  undecided: null,
} as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rejected = rejectImpersonatedWrite(req);
  if (rejected) return rejected;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id: companyId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  const { jobId, verdict, reason } = parsed.data;

  // Only while a proposal is on the table. A committed board is a record, not
  // a working surface — the UI hides the buttons, and this is the seam that
  // makes that true rather than merely displayed.
  const openRows = await prisma.jobInteraction.count({
    where: { userId: user.id, job: { companyId }, ...onBoardWhere() },
  });
  if (openRows === 0) {
    return Response.json(
      { error: "no shortlist proposal is open at this company" },
      { status: 409 },
    );
  }

  // runReconsiderJob handles both cases uniformly: a row already on the board
  // takes the stance directly (staying in its current group until the user's
  // next message); a still-unread role is read first, then pulled in.
  const result = await runReconsiderJob({
    userId: user.id,
    jobId,
    verdict: VERDICT_FOR[verdict],
    reason: reason?.trim() || null,
    by: ProposedBy.USER,
  });
  if (result.kind === "not_reconsiderable") {
    return Response.json(
      { error: "this role can't be marked from the board" },
      { status: 409 },
    );
  }

  const board = await loadShortlistBoard(user.id, companyId);
  if (!board) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(board);
}
