import { z } from "zod";

import { EventSource } from "@/generated/prisma/client";
import { LOG_JOB_EVENT_TYPES } from "@/server/entities/jobs/jobInteractionInputs";
import { logJobEvents } from "@/server/entities/jobs/logJobEvents";
import { resolveJobsBySlug } from "@/server/entities/resolveBySlug";
import { parseEventDateTime } from "@/server/platform/time/localTime";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

const LogJobEventItemSchema = z.object({
  job: z.string(),
  type: z.enum(LOG_JOB_EVENT_TYPES),
  occurredAt: z.string().optional(),
  notes: z.string().optional(),
  source: z.enum(["CHAT_EXTRACTED", "USER_LOGGED"]).optional(),
});

type LogJobEventItem = z.infer<typeof LogJobEventItemSchema>;

export const logJobEventsTool: ToolDef<{ events: LogJobEventItem[] }> = {
  name: "log_job_events",
  affectsViewedState: true,
  description:
    "Log one or more timeline events on JobInteractions (INTERVIEW_SCHEDULED when an interview is on the calendar, INTERVIEW_HAPPENED after it occurs, AWAITING_RESPONSE once you've talked through how it went and there's no next round/offer/rejection yet, REJECTED, OFFERED, WITHDRAWN to withdraw an application, NOTE for freeform observations, etc.). Batched — pass an array; one transaction. For APPLIED events, use mark_job_applied — it's the only path that wipes untouched cover-letter / short-answer drafts. Most event types auto-update the cached status. INTERVIEW_SCHEDULED covers phone screens, technicals, onsites — one status pair slugs all interview rounds; specify the round (phone screen / technical / onsite / final) in the per-item `notes`. The read-path lazily promotes INTERVIEW_SCHEDULED to INTERVIEW_DEBRIEF when the scheduled date passes, so don't manually nudge the status — log INTERVIEW_HAPPENED when the round is confirmed done. AWAITING_RESPONSE is the off-ramp after you've discussed the interview: it parks the role as 'waiting to hear back' so it stops resurfacing until the company replies (or ~2 weeks pass) — use it instead of leaving a debriefed role sitting there. WITHDRAWN moves status to CLOSED with closeReason=WITHDRAWN. SURFACED and SCANNED are informational only and don't change status. Don't double-log: one event per user-statement.",
  inputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            job: { type: "string", description: "The role's slug." },
            type: { type: "string", enum: LOG_JOB_EVENT_TYPES },
            occurredAt: {
              type: "string",
              description:
                "ISO datetime in the user's local time. For anything with a clock time (an interview, a call), INCLUDE the time — e.g. '2026-06-14T14:00' for a 2pm interview — so it's not treated as already-past. A bare date ('2026-06-14') is fine for untimed events (applied, a plain note). Use the # Today block for the current local date/time. Defaults to now.",
            },
            notes: { type: "string" },
            source: {
              type: "string",
              enum: ["CHAT_EXTRACTED", "USER_LOGGED"],
              description:
                "Default CHAT_EXTRACTED. USER_LOGGED is reserved for the structured form.",
            },
          },
          required: ["job", "type"],
        },
      },
    },
    required: ["events"],
  },
  parser: z.object({ events: z.array(LogJobEventItemSchema).min(1) }),
  async handle({ events }, ctx) {
    // Resolve every event's job slug up front — a stray unknown slug should
    // abort before the transaction opens (all-or-nothing batch), with a clear
    // message rather than an opaque FK failure.
    const { resolved, unknown } = await resolveJobsBySlug(
      events.map((e) => e.job),
    );
    if (unknown.length > 0) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `these job slug(s) don't match a role: ${unknown.join(", ")}. Re-run list_jobs / scrape_jobs_for_company to get current slugs.`,
        "log_job_events:not_found:job_slugs",
      );
    }
    const idBySlug = new Map<string, { id: string; slug: string | null }>();
    const slugByJobId = new Map<string, string>();
    for (const r of resolved) {
      if (r.slug) idBySlug.set(r.slug.trim(), { id: r.id, slug: r.slug });
      idBySlug.set(r.id.trim(), { id: r.id, slug: r.slug });
      slugByJobId.set(r.id, r.slug ?? r.id);
    }

    // The atomic write (upsert JobInteraction + JobEvent + status flip + company
    // dual-write) lives in logJobEvents; "auto" applies the EVENT_TO_STATUS
    // map + the WITHDRAWN close-reason. The tool only resolves slugs, maps the
    // agent's local-time + source, and formats the result.
    const results = await logJobEvents({
      userId: ctx.userId,
      items: events.map((ev) => ({
        jobId: idBySlug.get(ev.job.trim())!.id,
        type: ev.type,
        occurredAt: parseEventDateTime(ev.occurredAt, ctx.timeZone),
        notes: ev.notes,
        source:
          ev.source === "USER_LOGGED"
            ? EventSource.USER_LOGGED
            : EventSource.CHAT_EXTRACTED,
      })),
    });

    const summaries = results.map((r, i) => {
      const jobSlug = slugByJobId.get(r.jobId) ?? r.jobId;
      const parts: string[] = [];
      if (r.statusChangedTo) parts.push(`status → ${r.statusChangedTo}`);
      if (r.closeReasonSetTo) parts.push(`closeReason → ${r.closeReasonSetTo}`);
      // Say "no status change" rather than staying silent: this tool DOES move
      // the cached status for most types, so a bare line left Hank unable to
      // tell "nothing moved" from "this tool doesn't report that" — and he'd
      // narrate a status change that never happened.
      return parts.length > 0
        ? `- ${jobSlug} ${events[i].type}; ${parts.join(", ")}`
        : `- ${jobSlug} ${events[i].type}; no status change`;
    });

    return {
      content: `logged ${events.length} event${events.length === 1 ? "" : "s"}:\n${summaries.join("\n")}`,
    };
  },
};
