import { prisma } from "@/server/db/prisma";

// Lazy-flip INTERVIEW_SCHEDULED → INTERVIEW_DEBRIEF for rows whose latest
// interview event's occurredAt is in the past. Called at the start of the
// user-facing read paths (dashboard, focused-job, focused-company) so the
// rendered status reflects "user owes a debrief" instead of stuck on
// SCHEDULED. Decision rationale + cron alternative in
// [docs/lifecycle.md](../../../docs/lifecycle.md).
//
// Best-effort: any DB error gets logged but doesn't break the read. The
// UPDATE is idempotent so concurrent calls are safe.
export async function flipDueInterviewsToDebrief(): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "JobInteraction"
      SET status = 'INTERVIEW_DEBRIEF', "updatedAt" = NOW()
      WHERE status = 'INTERVIEW_SCHEDULED'
        AND id IN (
          SELECT e."jobInteractionId"
          FROM "JobEvent" e
          WHERE e.type = 'INTERVIEW_SCHEDULED'
          GROUP BY e."jobInteractionId"
          HAVING MAX(e."occurredAt") <= NOW()
        )
    `;
  } catch (err) {
    console.error("flipDueInterviewsToDebrief failed:", err);
  }
}
