// Throw away every board mark the user hasn't sent yet.
//
// User-scoped rather than per-company on purpose: the composer chip counts marks
// across every open board, so dismissing it has to clear exactly that set —
// otherwise the chip would come back with the ones it didn't reach.
//
// Discarding only touches STANCES. A mark on a filtered row doesn't un-close it
// until the relay (see settleRelayedBoardEdits), so there is no structural
// change to undo here and nothing can be half-reverted.

import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { discardUnrelayedBoardEdits } from "@/server/entities/jobs/boardStance";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rejected = rejectImpersonatedWrite(req);
  if (rejected) return rejected;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const discarded = await discardUnrelayedBoardEdits(user.id);
  return Response.json({ discarded });
}
