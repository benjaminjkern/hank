import { z } from "zod";

import {
  createOpportunities,
  type CreateOpportunityInput,
} from "@/server/entities/opportunities/createOpportunities";
import { ALL_LEAD_STATUSES } from "@/server/entities/opportunities/leadInputs";
import {
  resolveContactsBySlug,
  resolveJobInteractionsFromJobSlugs,
} from "@/server/entities/resolveBySlug";
import { parseEventDateTime } from "@/server/platform/time/localTime";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const CreateOpportunityItemSchema = z.object({
  label: z.string().min(1),
  status: z.enum(ALL_LEAD_STATUSES).optional(),
  primaryContact: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  nextStepAt: z.string().optional(),
  notes: z.string().optional(),
  sourceJob: z.string().optional(),
});

type CreateOpportunityItem = z.infer<typeof CreateOpportunityItemSchema>;

export const createOpportunitiesTool: ToolDef<{
  opportunities: CreateOpportunityItem[];
}> = {
  name: "create_opportunities",
  affectsViewedState: true,
  description:
    "Create one or more Opportunities — each is a **lead** for one inbound conversation (recruiter outreach, referral, intro). Batched — pass an array; one transaction. The pitched/discussed roles inside each lead are regular Jobs: after creating the opportunities, call `create_jobs([{opportunity, ...}, ...])` once per pitched role (pass the returned lead slug). Per-item `label` describes the lead, not a single role — e.g. 'McKenley Talent → Arcadia'. Auto-emits INBOUND_RECEIVED for each. If `nextStepAt` is set on an item, also auto-emits CALL_SCHEDULED and bumps status to SCREENING. Default status is OPEN. `sourceJob` is for when the inbound was triggered by a real existing tracked role (its slug); leave null for agency-posting inbounds.",
  inputSchema: {
    type: "object",
    properties: {
      opportunities: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description:
                "User-facing label for the lead/conversation. Write it like '<recruiter> at <agency>' or '<referrer> intro' or '<recruiter> → <hiring company>'.",
            },
            status: {
              type: "string",
              enum: ALL_LEAD_STATUSES as readonly string[] as string[],
              description:
                "Lead-level conversation status. Defaults to OPEN. Pass SCREENING explicitly only if a call is already on the calendar.",
            },
            primaryContact: {
              type: "string",
              description:
                "Optional contact slug for the headline recruiter/referrer.",
            },
            contacts: {
              type: "array",
              items: { type: "string" },
              description: "Additional contact slugs beyond the primary one.",
            },
            nextStepAt: {
              type: "string",
              description:
                "ISO datetime of the next scheduled moment (call, meeting), in the user's local time — INCLUDE the clock time (e.g. '2026-06-14T14:00' for a 2pm call) so it isn't treated as already-past. Auto-emits CALL_SCHEDULED and moves lead status to SCREENING.",
            },
            notes: {
              type: "string",
              description: "Freeform notes about the lead.",
            },
            sourceJob: {
              type: "string",
              description:
                "Set ONLY when this inbound was triggered by an existing tracked role (its slug) — e.g. user applied direct, recruiter from same company reached out. For agency-posting inbounds (Arcadia case), leave null.",
            },
          },
          required: ["label"],
        },
      },
    },
    required: ["opportunities"],
  },
  parser: z.object({
    opportunities: z.array(CreateOpportunityItemSchema).min(1),
  }),
  async handle({ opportunities }, ctx) {
    // Translate the agent's per-item slugs → ids and its local-time nextStepAt →
    // an absolute Date, surfacing a stray slug as a clean tool error (rather than
    // an FK abort inside the entity's transaction). Everything downstream is
    // plain domain values.
    // Every slug the batch mentions, resolved up front in one query per entity
    // type — not one per contact per lead. The loop below only reads the maps.
    const jobSlugs = [
      ...new Set(
        opportunities.map((o) => o.sourceJob).filter((j): j is string => !!j),
      ),
    ];
    const contactSlugs = [
      ...new Set(
        opportunities.flatMap((o) => [
          ...(o.primaryContact ? [o.primaryContact] : []),
          ...(o.contacts ?? []),
        ]),
      ),
    ];
    const [jobBySlug, contactBySlug] = await Promise.all([
      resolveJobInteractionsFromJobSlugs(ctx.userId, jobSlugs),
      resolveContactsBySlug(ctx.userId, contactSlugs),
    ]);

    const items: CreateOpportunityInput[] = [];
    for (let i = 0; i < opportunities.length; i++) {
      const input = opportunities[i];

      let sourceJobInteractionId: string | null = null;
      if (input.sourceJob) {
        const r = jobBySlug.get(input.sourceJob)!;
        if (!r.ok) {
          return slugLookupError(r, { itemPrefix: `item ${i}: ` });
        }
        sourceJobInteractionId = r.value.jobInteractionId;
      }

      let primaryContactId: string | null = null;
      if (input.primaryContact) {
        const r = contactBySlug.get(input.primaryContact)!;
        if (!r.ok) {
          return slugLookupError(r, { itemPrefix: `item ${i}: ` });
        }
        primaryContactId = r.value.id;
      }

      const contactIds: string[] = [];
      for (const slugOrCuid of input.contacts ?? []) {
        const r = contactBySlug.get(slugOrCuid)!;
        if (!r.ok) {
          return slugLookupError(r, { itemPrefix: `item ${i}: ` });
        }
        contactIds.push(r.value.id);
      }

      items.push({
        label: input.label,
        status: input.status,
        primaryContactId,
        contactIds,
        nextStepAt: parseEventDateTime(input.nextStepAt, ctx.timeZone),
        notes: input.notes,
        sourceJobInteractionId,
      });
    }

    const created = await createOpportunities({
      userId: ctx.userId,
      items,
    });

    const lines = created.map((c) => {
      const nextNote = c.nextStepAt
        ? ` nextStepAt=${c.nextStepAt.toISOString()}`
        : "";
      return `- ${c.slug ?? c.id} "${c.label}" status=${c.status}${nextNote}`;
    });
    return {
      content: `created ${created.length} opportunit${created.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}\nAdd pitched roles via create_jobs([{opportunity, title, company|companyName, ...}, ...]).`,
    };
  },
};
