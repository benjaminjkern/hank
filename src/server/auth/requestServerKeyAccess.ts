import { prisma } from "@/server/db/prisma";
import { notifyAdmin } from "@/server/platform/notifications/pushAdmin";
import { nowDate, nowMs } from "@/utils/now";

// A user blocked from chatting asks an admin to grant them the server key. The
// only way in on an instance that runs SERVER_KEY_BY_DEFAULT=false with own
// keys disallowed, so the ask has to exist somewhere the blocked user can see
// it — that's the chat blocker modal.

// Re-asking sooner than this is a no-op. One person tapping a button is not a
// threat, but every tap is a push notification on the admin's phone.
const REQUEST_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export type AccessRequestResult =
  { ok: true; alreadyPending: boolean } | { ok: false; error: string };

export async function requestServerKeyAccess(
  userId: string,
): Promise<AccessRequestResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      canUseServerKey: true,
      accessRequestedAt: true,
    },
  });
  if (!user) return { ok: false, error: "User not found." };
  if (user.canUseServerKey) {
    return { ok: false, error: "You already have access." };
  }

  const pendingSince = user.accessRequestedAt?.getTime();
  if (
    pendingSince !== undefined &&
    nowMs() - pendingSince < REQUEST_COOLDOWN_MS
  ) {
    return { ok: true, alreadyPending: true };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { accessRequestedAt: nowDate() },
  });

  // Fire-and-forget by contract (notifyAdmin no-ops without VAPID env) — the
  // request is recorded either way, and /admin/users is the durable surface.
  void notifyAdmin(
    "Hank access request",
    `${user.name ?? user.email ?? "Someone"} is asking for access`,
  );

  return { ok: true, alreadyPending: false };
}
