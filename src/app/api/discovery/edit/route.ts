// One checkbox from the discovery panel. Persists immediately (the list is DB
// truth — a refresh or a second device sees it); the relay to Hank is derived at
// the user's NEXT chat message (buildPanelEditBlocks snapshots the rows whose
// live mark has drifted from what he was told). Never wakes Hank.
//
// A mark decides nothing on its own: `commit_discovery` is what adds or records
// anything, which is why a click here can't cost a URL hunt and why the user can
// change their mind before sending.

import { z } from "zod";

import { CompanySuggestionMark } from "@/generated/prisma/client";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { setSuggestionMark } from "@/server/entities/companies/suggestionMark";
import { loadDiscoveryList } from "@/server/views/discoveryList";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  suggestionId: z.string(),
  // Binary: the checkbox is on or off. Unchecking writes PASS rather than
  // clearing the mark, because "not adding this one" is a real answer the
  // commit acts on — there is no third state to fall back to.
  mark: z.enum(["add", "pass"]),
});

const MARK_FOR = {
  add: CompanySuggestionMark.ADD,
  pass: CompanySuggestionMark.PASS,
} as const;

export async function POST(req: Request) {
  const rejected = rejectImpersonatedWrite(req);
  if (rejected) return rejected;
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad body" }, { status: 400 });
  }

  const result = await setSuggestionMark({
    userId: user.id,
    suggestionId: parsed.data.suggestionId,
    mark: MARK_FOR[parsed.data.mark],
  });
  if (!result.ok) {
    // Already settled, or not this user's row — either way there's nothing to
    // mark, and the panel's copy is stale.
    return Response.json(
      { error: "that company isn't on the list any more" },
      { status: 409 },
    );
  }

  return Response.json(await loadDiscoveryList(user.id));
}
