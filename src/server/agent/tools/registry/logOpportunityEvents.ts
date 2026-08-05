import { z } from "zod";

import { EventSource } from "@/generated/prisma/client";
import { ALL_EVENT_TYPES } from "@/server/entities/opportunities/leadInputs";
import { logOpportunityEvents } from "@/server/entities/opportunities/logOpportunityEvent";
import { resolveOpportunitiesBySlug } from "@/server/entities/resolveBySlug";
import { parseEventDateTime } from "@/server/platform/time/localTime";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const LogOpportunityEventItemSchema = z.object({
  opportunity: z.string(),
  type: z.enum(ALL_EVENT_TYPES),
  occurredAt: z.string().optional(),
  notes: z.string().optional(),
  source: z.enum(["CHAT_EXTRACTED", "USER_LOGGED"]).optional(),
});

type LogOpportunityEventItem = z.infer<typeof LogOpportunityEventItemSchema>;

export const logOpportunityEventsTool: ToolDef<{
  events: LogOpportunityEventItem[];
}> = {
  name: "log_opportunity_events",
  affectsViewedState: true,
  description:
    "Log one or more timeline events on Opportunities (leads/conversations). Batched — pass an array; one transaction. CALL_SCHEDULED → lead status → SCREENING. CALL_HAPPENED → keeps SCREENING. NEXT_STEP_RECEIVED → lead status → AWAITING. CLOSED → lead status → CLOSED (set `closedReason` via update_opportunity). NOTE = freeform observation. A pitched role's own status lives on the linked JobInteraction's Event timeline, not here. Status auto-cache is denormalized; the event log is truth.",
  inputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            opportunity: { type: "string", description: "The lead's slug." },
            type: {
              type: "string",
              enum: ALL_EVENT_TYPES as readonly string[] as string[],
            },
            occurredAt: {
              type: "string",
              description:
                "ISO datetime in the user's local time — include the clock time for a scheduled call/meeting (e.g. '2026-06-14T14:00'). Defaults to now.",
            },
            notes: { type: "string" },
            source: {
              type: "string",
              enum: ["CHAT_EXTRACTED", "USER_LOGGED"],
              description: "Default CHAT_EXTRACTED.",
            },
          },
          required: ["opportunity", "type"],
        },
      },
    },
    required: ["events"],
  },
  parser: z.object({
    events: z.array(LogOpportunityEventItemSchema).min(1),
  }),
  async handle({ events }, ctx) {
    // Resolve each event's opportunity slug → id up front (ownership-checked by
    // resolveOpportunitiesBySlug, which scopes to userId). Fail fast on an unknown
    // slug before the write. The event insert + status auto-cache lives in
    // logOpportunityEvents; the tool only translates slugs + local-time and
    // formats the result.
    const slugByOppId = new Map<string, string>();
    const items = [];
    // Resolved up front in one query — not one per event.
    const oppSlugs = [...new Set(events.map((e) => e.opportunity))];
    const oppBySlug = await resolveOpportunitiesBySlug(ctx.userId, oppSlugs);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const r = oppBySlug.get(ev.opportunity)!;
      if (!r.ok) {
        return slugLookupError(r, { itemPrefix: `item ${i}: ` });
      }
      slugByOppId.set(r.value.id, r.value.slug ?? r.value.id);
      items.push({
        opportunityId: r.value.id,
        type: ev.type,
        occurredAt: parseEventDateTime(ev.occurredAt, ctx.timeZone),
        notes: ev.notes,
        source:
          ev.source === "USER_LOGGED"
            ? EventSource.USER_LOGGED
            : EventSource.CHAT_EXTRACTED,
      });
    }

    const results = await logOpportunityEvents({ userId: ctx.userId, items });

    const lines = results
      .map((r, i) => {
        if (!r) return null;
        const oppSlug = slugByOppId.get(r.opportunityId) ?? r.opportunityId;
        const parts: string[] = [];
        if (r.statusChangedTo) parts.push(`status → ${r.statusChangedTo}`);
        if (r.nextStepAtSetTo)
          parts.push(`nextStepAt → ${r.nextStepAtSetTo.toISOString()}`);
        // Explicit "no status change" for the same reason as log_job_events:
        // this tool DOES move the lead's cached status for most types, so
        // silence read as "unreported" rather than "unchanged".
        return `- ${oppSlug} ${events[i].type}${parts.length > 0 ? `; ${parts.join(", ")}` : "; no status change"}`;
      })
      .filter((l): l is string => l !== null);

    return {
      content: `logged ${events.length} opportunity event${events.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    };
  },
};
