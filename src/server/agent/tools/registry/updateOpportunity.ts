import { z } from "zod";

import type { OpportunityStatus } from "@/generated/prisma/client";
import { ALL_LEAD_STATUSES } from "@/server/entities/opportunities/leadInputs";
import {
  updateOpportunity,
  type UpdateOpportunityPatch,
} from "@/server/entities/opportunities/updateOpportunity";
import {
  resolveContactBySlug,
  resolveJobInteractionFromJobSlug,
  resolveOpportunityBySlug,
} from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const updateOpportunityTool: ToolDef<{
  opportunity: string;
  label?: string;
  status?: OpportunityStatus;
  primaryContact?: string | null;
  nextStepAt?: string | null;
  notes?: string;
  closedReason?: string;
  sourceJob?: string | null;
}> = {
  name: "update_opportunity",
  affectsViewedState: true,
  description:
    "Update the **lead-level** fields of an Opportunity (identified by its slug) — label, conversation status, primary contact, nextStepAt, notes, closedReason, source link. Role-level edits (title, company, status) go through update_job / log_job_events on the linked role. Status changes that correspond to an event (call scheduled, next step received, closed) should go through log_opportunity_events so the timeline reflects them. Pass null to clear `primaryContact`, `nextStepAt`, or `sourceJob`. `primaryContact` takes a contact slug; `sourceJob` takes the slug of the role that triggered the inbound.",
  inputSchema: {
    type: "object",
    properties: {
      opportunity: { type: "string", description: "The lead's slug." },
      label: { type: "string" },
      status: {
        type: "string",
        enum: ALL_LEAD_STATUSES as readonly string[] as string[],
        description:
          "Direct status overwrite. Prefer log_opportunity_events for state transitions so the timeline records why.",
      },
      primaryContact: {
        type: ["string", "null"],
        description: "Contact slug, or null to clear.",
      },
      nextStepAt: {
        type: ["string", "null"],
        description: "ISO datetime, or null to clear.",
      },
      notes: { type: "string" },
      closedReason: { type: "string" },
      sourceJob: {
        type: ["string", "null"],
        description: "Role slug that triggered the inbound, or null to clear.",
      },
    },
    required: ["opportunity"],
  },
  parser: z.object({
    opportunity: z.string(),
    label: z.string().min(1).optional(),
    status: z.enum(ALL_LEAD_STATUSES).optional(),
    primaryContact: z.string().nullable().optional(),
    nextStepAt: z.string().nullable().optional(),
    notes: z.string().optional(),
    closedReason: z.string().optional(),
    sourceJob: z.string().nullable().optional(),
  }),
  async handle({ opportunity, ...patch }, ctx) {
    const opportunityResolved = await resolveOpportunityBySlug(
      ctx.userId,
      opportunity,
    );
    if (!opportunityResolved.ok) {
      return slugLookupError(opportunityResolved);
    }
    const opportunityId = opportunityResolved.value.id;

    // Translate the agent's slugs → ids before handing a plain-value patch to
    // the entity layer. Per-field: undefined = leave unchanged, null = clear.
    const resolved: UpdateOpportunityPatch = {
      label: patch.label,
      status: patch.status,
      notes: patch.notes,
      closedReason: patch.closedReason,
    };
    if (patch.nextStepAt !== undefined) {
      resolved.nextStepAt = patch.nextStepAt
        ? new Date(patch.nextStepAt)
        : null;
    }
    if (patch.primaryContact !== undefined) {
      if (patch.primaryContact === null) {
        resolved.primaryContactId = null;
      } else {
        const r = await resolveContactBySlug(ctx.userId, patch.primaryContact);
        if (!r.ok) return slugLookupError(r);
        resolved.primaryContactId = r.value.id;
      }
    }
    if (patch.sourceJob !== undefined) {
      if (patch.sourceJob === null) {
        resolved.sourceJobInteractionId = null;
      } else {
        const r = await resolveJobInteractionFromJobSlug(
          ctx.userId,
          patch.sourceJob,
        );
        if (!r.ok) return slugLookupError(r);
        resolved.sourceJobInteractionId = r.value.jobInteractionId;
      }
    }

    const result = await updateOpportunity({
      userId: ctx.userId,
      opportunityId,
      patch: resolved,
    });
    if (!result.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `(no opportunity found for "${opportunity}")`,
        "update_opportunity:not_found:opportunity",
      );
    }
    if (result.changedFields.length === 0) {
      return { content: "no fields to update" };
    }

    return {
      content: `updated ${opportunityResolved.value.slug ?? opportunityId} fields: ${result.changedFields.join(", ")}`,
    };
  },
};
