// Throw away every unsent change on one negotiation panel — the composer chip's
// dismiss.
//
// User-scoped rather than per-entity on purpose: each chip counts the changes on
// its whole surface (marks across every open board, edits across every open
// application), so dismissing one has to clear exactly that set — otherwise the
// chip comes back holding the ones it didn't reach.
//
// It is a real undo, not a dismissal. Each surface puts its rows back to what
// Hank last saw, which is the same baseline the pending flag is measured
// against, so a discarded panel reports nothing at all on the next message.

import { z } from "zod";

import { NEGOTIATION_PANELS } from "@/lib/panelMode";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { discardUnrelayedSuggestionMarks } from "@/server/entities/companies/suggestionMark";
import { discardUnrelayedApplicationEdits } from "@/server/entities/jobs/applicationDrafts";
import { discardUnrelayedBoardEdits } from "@/server/entities/jobs/boardStance";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ panel: z.enum(NEGOTIATION_PANELS) });

export async function POST(req: Request) {
  const rejected = rejectImpersonatedWrite(req);
  if (rejected) return rejected;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const discarded =
    parsed.data.panel === "shortlist-board"
      ? await discardUnrelayedBoardEdits(user.id)
      : parsed.data.panel === "discovery"
        ? await discardUnrelayedSuggestionMarks(user.id)
        : await discardUnrelayedApplicationEdits(user.id);
  return Response.json({ discarded });
}
