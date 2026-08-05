import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

import { AdminNotesView, type AdminNoteRow } from "./AdminNotesView";

export const dynamic = "force-dynamic";

export default async function AdminNotesPage() {
  await requireAdmin();

  // Admin notes are a god-view across all users — the index count is global,
  // so the detail page must be too. Per-user filtering happens client-side in
  // AdminNotesView via the user dropdown.
  const openRaw = await prisma.adminNote.findMany({
    where: { dismissed: false },
    orderBy: { lastSeenAt: "desc" },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  // Sort open notes by severity (HIGH first), then occurrenceCount desc, then
  // lastSeenAt desc — admin triage starts with the loudest signals.
  // Postgres doesn't sort enums-as-strings the way we want, so we order in JS
  // after the query (the table is small enough that this is fine).
  const SEV_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const open = openRaw.slice().sort((a, b) => {
    const sevA = SEV_RANK[a.severity] ?? 2;
    const sevB = SEV_RANK[b.severity] ?? 2;
    if (sevA !== sevB) return sevB - sevA;
    if (a.occurrenceCount !== b.occurrenceCount) {
      return b.occurrenceCount - a.occurrenceCount;
    }
    return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  });
  const recentlyDismissed = await prisma.adminNote.findMany({
    where: { dismissed: true },
    orderBy: { lastSeenAt: "desc" },
    take: 20,
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  const toRow = (n: (typeof openRaw)[number]): AdminNoteRow => ({
    id: n.id,
    category: n.category,
    severity: n.severity,
    summary: n.summary,
    context: n.context,
    sessionId: n.sessionId,
    messageId: n.messageId,
    dedupKey: n.dedupKey,
    occurrenceCount: n.occurrenceCount,
    createdAt: n.createdAt.toISOString(),
    lastSeenAt: n.lastSeenAt.toISOString(),
    dismissed: n.dismissed,
    userId: n.userId,
    userLabel: n.user.email ?? n.user.name ?? n.userId,
  });

  return (
    <AdminNotesView
      open={open.map(toRow)}
      recentlyDismissed={recentlyDismissed.map(toRow)}
    />
  );
}
