// The opportunity (inbound lead) detail page's loader. The payload type is
// shared/views/getFocusedOpportunity.ts.

import { prisma } from "@/server/db/prisma";
import { CONTACT_SELECT } from "@/server/views/contactView";
import type { ContactView } from "@/shared/views/contactView";
import type {
  FocusedOpportunityView,
  OpportunityJobView,
} from "@/shared/views/getFocusedOpportunity";

const RECENT_EVENTS_LIMIT = 12;

// Shared loader for a single opportunity (the lead) + its child JobInteractions,
// contacts, and events. Used by /api/session, /api/opportunities/[id], and the
// agent's show_opportunity tool so the SSE payload and the page hydration are
// byte-identical (mirrors the getFocusedJobView / getFocusedCompanyView pair;
// "focused" here just means the rich detail payload — no focus slot anymore).
export async function getFocusedOpportunityView(
  userId: string,
  opportunityId: string,
): Promise<FocusedOpportunityView | null> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, userId },
    select: {
      id: true,
      slug: true,
      label: true,
      status: true,
      nextStepAt: true,
      notes: true,
      closedReason: true,
      createdAt: true,
      updatedAt: true,
      sourceJobInteraction: {
        select: {
          jobId: true,
          job: {
            select: {
              title: true,
              companyName: true,
              company: { select: { id: true, name: true } },
            },
          },
        },
      },
      primaryContact: { select: CONTACT_SELECT },
      opportunityContacts: {
        select: { contact: { select: CONTACT_SELECT } },
      },
      jobInteractions: {
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          status: true,
          closeReason: true,
          closeNote: true,
          createdAt: true,
          updatedAt: true,
          events: {
            orderBy: { occurredAt: "desc" },
            // A few rather than one so a NOTE logged after applying/closing
            // doesn't hide the APPLIED / terminal event we date from.
            take: 6,
            select: { type: true, occurredAt: true },
          },
          job: {
            select: {
              id: true,
              title: true,
              sourceUrl: true,
              companyId: true,
              companyName: true,
              closedAt: true,
              company: { select: { name: true } },
            },
          },
        },
      },
      events: {
        orderBy: { occurredAt: "desc" },
        take: RECENT_EVENTS_LIMIT,
        select: { id: true, type: true, occurredAt: true, notes: true },
      },
    },
  });
  if (!opp) return null;

  const note = await prisma.memoryNote.findUnique({
    where: {
      userId_path: {
        userId,
        path: `opportunities/${opp.slug ?? opp.id}.md`,
      },
    },
    select: { content: true },
  });

  const primaryContact = opp.primaryContact;
  // De-dupe: primaryContact may also appear in opportunityContacts.
  const contacts: ContactView[] = [];
  const seen = new Set<string>();
  if (primaryContact) {
    contacts.push(primaryContact);
    seen.add(primaryContact.id);
  }
  for (const oc of opp.opportunityContacts) {
    if (seen.has(oc.contact.id)) continue;
    contacts.push(oc.contact);
    seen.add(oc.contact.id);
  }

  const jobInteractions: OpportunityJobView[] = opp.jobInteractions.map(
    (ji) => ({
      jobInteractionId: ji.id,
      jobId: ji.job.id,
      title: ji.job.title,
      companyId: ji.job.companyId,
      // Prefer the joined Company.name once a real Company is linked; fall back
      // to the freeform string on Job.companyName for agency-pitched roles where
      // the hiring company isn't on the watchlist yet.
      companyName: ji.job.company?.name ?? ji.job.companyName,
      status: ji.status,
      closeReason: ji.closeReason,
      closeNote: ji.closeNote,
      sourceUrl: ji.job.sourceUrl,
      createdAt: ji.createdAt.toISOString(),
      updatedAt: ji.updatedAt.toISOString(),
      // Application date for an APPLIED role aging without a response.
      appliedAt:
        ji.status === "APPLIED"
          ? (ji.events
              .find((e) => e.type === "APPLIED")
              ?.occurredAt.toISOString() ?? null)
          : null,
      // When the role ended. DELISTED dates off Job.closedAt — the global
      // takedown date, and the authority (its JobEvent isn't fetched here);
      // CLOSED/REJECTED (withdrawals log WITHDRAWN) use the latest terminal event.
      closedAt:
        ji.status === "DELISTED"
          ? (ji.job.closedAt?.toISOString() ?? null)
          : ji.status === "CLOSED" || ji.status === "REJECTED"
            ? (ji.events
                .find(
                  (e) =>
                    e.type === "CLOSED" ||
                    e.type === "REJECTED" ||
                    e.type === "WITHDRAWN",
                )
                ?.occurredAt.toISOString() ?? null)
            : null,
    }),
  );

  return {
    id: opp.id,
    slug: opp.slug,
    label: opp.label,
    status: opp.status,
    nextStepAt: opp.nextStepAt?.toISOString() ?? null,
    notes: opp.notes,
    closedReason: opp.closedReason,
    sourceJobInteraction: opp.sourceJobInteraction
      ? {
          jobId: opp.sourceJobInteraction.jobId,
          title: opp.sourceJobInteraction.job.title,
          companyId: opp.sourceJobInteraction.job.company?.id ?? null,
          companyName:
            opp.sourceJobInteraction.job.company?.name ??
            opp.sourceJobInteraction.job.companyName,
        }
      : null,
    primaryContact,
    contacts,
    jobInteractions,
    events: opp.events.map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      notes: e.notes,
    })),
    memoryNote: note?.content ?? null,
    createdAt: opp.createdAt.toISOString(),
    updatedAt: opp.updatedAt.toISOString(),
  };
}
