import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { prisma } from "@/server/db/prisma";
import { recordClientEvent } from "@/server/platform/clientEvents/record";
import { ClientEventInputSchema } from "@/server/platform/clientEvents/types";

export const dynamic = "force-dynamic";

// Browser-reported client events: SSE disconnects, ApiKeyBlocker
// triggers, right-panel render crashes, Stop clicks, widget render failures —
// things that happen in the user's browser and otherwise never reach the agent
// or the admin. Fire-and-forget from the client; recordClientEvent swallows its
// own errors (incl. a not-yet-migrated table), so this never breaks a session.
export async function POST(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = ClientEventInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  // Resolve the caller's active session server-side (find-only — don't create a
  // session as a side effect of a stray telemetry event). No active session →
  // nothing to attach the event to; ack and drop.
  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (session) {
    await recordClientEvent(user.id, session.id, parsed.data);
  }
  return Response.json({ ok: true });
}
