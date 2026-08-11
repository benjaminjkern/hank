import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

import { AdminUsersView, type AdminUserRow } from "./AdminUsersView";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  await requireAdmin();
  const rows = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      canUseServerKey: true,
      accessRequestedAt: true,
      anthropicKeyHint: true,
      anthropicKeyUpdatedAt: true,
      createdAt: true,
      // Most-recent non-ended session — the "live" one. Inspect-session
      // affordance on the row links here directly; older sessions are
      // reachable via the session pills in /admin/notes and /admin/usage.
      sessions: {
        where: { endedAt: null },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  const users: AdminUserRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    isAdmin: r.isAdmin,
    canUseServerKey: r.canUseServerKey,
    accessRequestedAt: r.accessRequestedAt
      ? r.accessRequestedAt.toISOString()
      : null,
    keyHint: r.anthropicKeyHint,
    keyUpdatedAt: r.anthropicKeyUpdatedAt
      ? r.anthropicKeyUpdatedAt.toISOString()
      : null,
    createdAt: r.createdAt.toISOString(),
    activeSessionId: r.sessions[0]?.id ?? null,
  }));
  return <AdminUsersView users={users} />;
}
