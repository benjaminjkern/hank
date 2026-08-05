// Domain core for creating inbound leads (Opportunities). Shared behind the
// create_opportunities tool: creates one or more Opportunity rows + their
// contact links and seed events in a single transaction, and mints slugs.
//
// Works purely in ids + Dates — translating the agent's slugs → ids and its
// local-time strings → Dates is the tool layer's job, so this stays reusable and
// free of agent/UI vocabulary.

import {
  EventSource,
  OpportunityEventType,
  OpportunityStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { mintOpportunitySlug } from "./opportunitySlug";

// One lead to create, with the agent's slugs already resolved to ids and the
// local-time nextStepAt already parsed to an absolute Date.
export type CreateOpportunityInput = {
  label: string;
  // Explicit lead status; when omitted, defaults to SCREENING if a call is
  // scheduled (nextStepAt set), else OPEN.
  status?: OpportunityStatus;
  primaryContactId: string | null;
  contactIds: string[];
  nextStepAt: Date | null;
  notes?: string | null;
  sourceJobInteractionId: string | null;
};

export type CreatedOpportunity = {
  id: string;
  label: string;
  slug: string | null;
  status: OpportunityStatus;
  nextStepAt: Date | null;
};

export async function createOpportunities(args: {
  userId: string;
  items: CreateOpportunityInput[];
}): Promise<CreatedOpportunity[]> {
  const { userId, items } = args;

  const now = new Date();
  const rows = items.map((item) => ({
    userId,
    label: item.label,
    status:
      item.status ??
      (item.nextStepAt ? OpportunityStatus.SCREENING : OpportunityStatus.OPEN),
    primaryContactId: item.primaryContactId,
    nextStepAt: item.nextStepAt,
    notes: item.notes ?? null,
    sourceJobInteractionId: item.sourceJobInteractionId,
  }));

  // Three statements for any number of leads, not four per lead. The leads go in
  // first because their ids are what the links and events reference —
  // createManyAndReturn hands them back in input order, so the two createManys
  // below can be built without a round trip per lead.
  const created = await prisma.$transaction(async (tx) => {
    const opps = await tx.opportunity.createManyAndReturn({
      data: rows,
      select: { id: true, label: true },
    });
    // createManyAndReturn hands rows back in input order (Postgres returns a
    // plain multi-row INSERT's RETURNING rows in VALUES order), which is what
    // every `[i]` below relies on to pair a lead with its contacts, its seed
    // events and its slug. Checked rather than trusted — a silent reorder would
    // link the wrong recruiter to the wrong lead.
    if (opps.some((opp, i) => opp.label !== items[i].label)) {
      throw new Error(
        "opportunity createManyAndReturn came back out of input order — refusing to pair rows by index",
      );
    }

    const links = opps.flatMap((opp, i) => {
      const contactIds = new Set<string>();
      if (items[i].primaryContactId) contactIds.add(items[i].primaryContactId);
      for (const id of items[i].contactIds) contactIds.add(id);
      return [...contactIds].map((contactId) => ({
        opportunityId: opp.id,
        contactId,
      }));
    });
    if (links.length > 0) {
      await tx.opportunityContact.createMany({
        data: links,
        skipDuplicates: true,
      });
    }

    // Every lead opens with INBOUND_RECEIVED; one with a call already booked
    // also gets the CALL_SCHEDULED that put it in SCREENING.
    const events = opps.flatMap((opp, i) => [
      {
        opportunityId: opp.id,
        type: OpportunityEventType.INBOUND_RECEIVED,
        occurredAt: now,
        notes: null,
        source: EventSource.CHAT_EXTRACTED,
      },
      ...(items[i].nextStepAt
        ? [
            {
              opportunityId: opp.id,
              type: OpportunityEventType.CALL_SCHEDULED,
              occurredAt: items[i].nextStepAt,
              notes: null,
              source: EventSource.CHAT_EXTRACTED,
            },
          ]
        : []),
    ]);
    await tx.opportunityEvent.createMany({ data: events });

    return opps.map((opp, i) => ({
      id: opp.id,
      label: opp.label,
      slug: null as string | null,
      status: rows[i].status,
      nextStepAt: items[i].nextStepAt,
    }));
  });

  // Mint each opportunity's slug AFTER the transaction commits — the slug mint
  // retries on unique-collision, which would abort an enclosing transaction.
  // Independent per lead, so they mint concurrently. Aligned by index.
  //
  // Deliberately one write per row rather than a single bulk update: the mint
  // resolves collisions by ATTEMPTING the write and catching the unique
  // violation, because pre-checking with a read races two concurrent minters
  // onto the same slug. Batching would mean pre-checking. Bounded and concurrent
  // (a create batch is a handful of rows), so it stays.
  const slugs = await Promise.all(
    created.map((c) => mintOpportunitySlug(c.id, c.label)),
  );
  created.forEach((c, i) => (c.slug = slugs[i]));

  return created;
}
