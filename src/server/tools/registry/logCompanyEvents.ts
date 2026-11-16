import { z } from "zod";

import {
  LOG_COMPANY_EVENT_TYPES,
  logCompanyEvents,
} from "@/server/entities/companies/logCompanyEvent";
import {
  resolveCompaniesBySlug,
  resolveJobsBySlug,
  type SlugLookup,
} from "@/server/entities/resolveBySlug";
import { EventSource } from "@/server/generated/prisma/client";
import { parseEventDateTime } from "@/shared/utils/localTime";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const LogCompanyEventItemSchema = z.object({
  company: z.string().describe("The company's slug."),
  type: z.enum(LOG_COMPANY_EVENT_TYPES),
  occurredAt: z
    .string()
    .optional()
    .describe(
      "ISO datetime in the user's local time. Include the clock time for a timed event (e.g. '2026-06-14T14:00'). Defaults to now.",
    ),
  notes: z.string().optional(),
  source: z
    .enum(["CHAT_EXTRACTED", "USER_LOGGED"])
    .optional()
    .describe("Default CHAT_EXTRACTED."),
  job: z
    .string()
    .optional()
    .describe(
      "Optional role slug — pass for a per-role milestone (APPLIED / INTERVIEW_* / …) so the feed row shows the role title. Ignored for company-wide types.",
    ),
});

type LogCompanyEventItem = z.infer<typeof LogCompanyEventItemSchema>;

export const logCompanyEventsTool: ToolDef<{ events: LogCompanyEventItem[] }> =
  {
    name: "log_company_events",
    affectsViewedState: true,
    description:
      "Log one or more timeline events on the company feed (the company page's 'Recent activity'). Batched — pass an array. `company` (the company slug) is required per item. `type` is any CompanyEventType: batch summaries (SCRAPE_FOUND / JOBS_CLOSED / SHORTLIST_RAN), per-role milestones (APPLIED / RESPONDED / INTERVIEW_SCHEDULED / INTERVIEW_HAPPENED / OFFERED / REJECTED / WITHDRAWN), or company status markers (PAUSED / BLOCKED / CLOSED / CAUGHT_UP / REVIVED). NOTE: the per-role milestone types and status markers are normally written automatically when you apply / log an interview on a role or change the company's status — reach for this tool for a standalone feed entry the automatic writers didn't cover (e.g. backfilling history the user tells you about). For a milestone tied to one role, pass its `job` slug so the feed row shows the role title. This only writes the company feed; it does NOT create a paired JobEvent or change any status.",
    parser: z.object({
      events: z.array(LogCompanyEventItemSchema).min(1),
    }),
    async handle({ events }, ctx) {
      // Resolve each item's company slug → id (and optional job slug → id+title)
      // up front. Fail fast on an unknown slug before any write. The insert lives
      // in logCompanyEvents; the tool only translates slugs + local-time.
      const rows = [];
      // Both slug sets resolved up front in one query each — not one per event.
      const companySlugs = [...new Set(events.map((e) => e.company))];
      const jobSlugs = [
        ...new Set(events.map((e) => e.job).filter((j): j is string => !!j)),
      ];
      const [companyBySlug, jobRows] = await Promise.all([
        resolveCompaniesBySlug(ctx.userId, companySlugs),
        resolveJobsBySlug(jobSlugs),
      ]);
      const jobBySlug = new Map<
        string,
        SlugLookup<(typeof jobRows.resolved)[number]>
      >(
        jobSlugs.map((slug) => {
          const hit = jobRows.resolved.find(
            (j) => j.slug === slug || j.id === slug,
          );
          return [
            slug,
            hit
              ? { ok: true, value: hit }
              : {
                  ok: false,
                  entity: "job",
                  attempted: slug,
                  availableSlugs: [],
                },
          ];
        }),
      );

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const c = companyBySlug.get(ev.company)!;
        if (!c.ok) {
          return slugLookupError(c, { itemPrefix: `item ${i}: ` });
        }
        let jobId: string | null = null;
        let jobTitle: string | null = null;
        if (ev.job) {
          const j = jobBySlug.get(ev.job)!;
          if (!j.ok) {
            return slugLookupError(j, { itemPrefix: `item ${i}: ` });
          }
          jobId = j.value.id;
          jobTitle = j.value.title;
        }
        rows.push({
          userId: ctx.userId,
          companyId: c.value.id,
          type: ev.type,
          occurredAt:
            parseEventDateTime(ev.occurredAt, ctx.timeZone) ?? new Date(),
          notes: ev.notes,
          source:
            ev.source === "USER_LOGGED"
              ? EventSource.USER_LOGGED
              : EventSource.CHAT_EXTRACTED,
          jobId,
          jobTitle,
        });
      }

      await logCompanyEvents(rows);

      const lines = rows.map((r, i) => `- ${events[i].company} ${r.type}`);
      return {
        // Unlike log_job_events / log_opportunity_events, this one NEVER moves a
        // status — company status isn't driven by the feed. Said once for the
        // whole batch rather than per line.
        content: `logged ${rows.length} company event${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nFeed rows only — no company status changed. To correct a company's status, use update_company_interaction.`,
      };
    },
  };
