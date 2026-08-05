import { z } from "zod";

import {
  CompanyStatus,
  type CompanyBlockReason,
  type CompanyCloseReason,
  type CompanyPauseReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  COMPANY_BLOCK_REASONS,
  COMPANY_CLOSE_REASONS,
  COMPANY_PAUSE_REASONS,
  SETTABLE_COMPANY_STATUSES,
} from "@/server/entities/companies/companyInteractionInputs";
import { updateCompanyInteraction } from "@/server/entities/companies/updateCompanyInteraction";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// The company twin of update_job_interaction: a pure record correction on the
// watchlist row. There is deliberately NO bulk company-status tool — nothing
// needs one. No status tool ends the turn any more (close/pause/block dropped
// `handoff` when the wrap moved into the mutation), so "pause these six" is six
// calls in one turn, each naming exactly which status + which "why" it wrote.

// Which reason param each status wants — drives both the missing-reason error
// and the "you passed a sibling list's value" hint (all three lists share OTHER,
// so a bare enum rejection at the dispatcher couldn't tell the agent which
// param it actually meant).
const REASONS_BY_STATUS = {
  [CompanyStatus.CLOSED]: {
    param: "closeReason",
    offered: COMPANY_CLOSE_REASONS as readonly string[],
  },
  [CompanyStatus.PAUSED]: {
    param: "pauseReason",
    offered: COMPANY_PAUSE_REASONS as readonly string[],
  },
  [CompanyStatus.BLOCKED]: {
    param: "blockReason",
    offered: COMPANY_BLOCK_REASONS as readonly string[],
  },
} as const;

export const updateCompanyInteractionTool: ToolDef<{
  company: string;
  status?: CompanyStatus;
  closeReason?: string;
  closeNote?: string;
  pauseReason?: string;
  pauseNote?: string;
  blockReason?: string;
  blockNote?: string;
}> = {
  name: "update_company_interaction",
  affectsViewedState: true,
  description:
    "**REPAIR TOOL — NOT the normal way to change a company's status. It writes the row and logs NOTHING to their activity feed, so the company's history will have no record of the change. It also does NOT touch their roles and does NOT re-scan the board.** Reach for it ONLY when the stored record is simply WRONG and you're fixing a bookkeeping error: the user says a company you have as passed is actually just on hold, or as closed is actually still live, or the reason on it is off. **If the thing is happening NOW — the user is passing on them, setting them aside, or done with what they have — that is the standard flow and MUST go through the real levers so it lands in the history: close_company (passing on them now — also closes their open roles), pause_company (setting them aside now), block_company (you couldn't read their board), caught_up_company (worked through what they have), company_walkthrough (revive a closed/blocked company and re-check the board).** Ask yourself which it is before calling: 'the record is wrong' → here; 'this just happened' → one of those. What it corrects: status, plus the structured why behind a pass (`closeReason` + `closeNote`), a hold (`pauseReason` + `pauseNote`) or an unreadable board (`blockReason` + `blockNote`). Fixing a handful of companies in one go is fine — this tool does NOT end your turn, so call it once per company. If the correction should ALSO be visible in their activity feed, log it separately with log_company_events (that tool writes the feed and nothing else) — do that when the user would want a trace, not by reflex. This is for COMPANIES — never pass a role's slug to it; for a role use update_job_interaction.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "The company's slug." },
      status: {
        type: "string",
        enum: SETTABLE_COMPANY_STATUSES as readonly string[] as string[],
        description:
          "Set the company's status directly. CLOSED requires closeReason, PAUSED requires pauseReason, BLOCKED requires blockReason; any other status clears all three reason pairs (a revived company keeps no stale 'why'). Setting a status REWRITES the why — pass the note again if it should survive. IN_FLIGHT / IN_PROCESS / CAUGHT_UP are normally derived from the company's roles, so a wrong one there is usually a wrong ROLE status underneath — fix that instead.",
      },
      closeReason: {
        type: "string",
        enum: COMPANY_CLOSE_REASONS as readonly string[] as string[],
        description:
          "Structured reason this company is a dead-end. Only valid alongside status CLOSED, or on its own to fix the reason on an already-closed company.",
      },
      closeNote: {
        type: "string",
        description:
          "Freeform explanation for the pass — the specific 'why' beyond the bucket, in the user's own words where possible.",
      },
      pauseReason: {
        type: "string",
        enum: COMPANY_PAUSE_REASONS as readonly string[] as string[],
        description:
          "Structured reason this company is set aside. Only valid alongside status PAUSED, or on its own to fix the reason on an already-paused company.",
      },
      pauseNote: {
        type: "string",
        description:
          "Freeform explanation for the hold, in the user's own words where possible — one sentence.",
      },
      blockReason: {
        type: "string",
        enum: COMPANY_BLOCK_REASONS as readonly string[] as string[],
        description:
          "Structured reason their board couldn't be read — a TECHNICAL set-aside, never a fit judgment. Only valid alongside status BLOCKED, or on its own to fix the reason on an already-blocked company.",
      },
      blockNote: {
        type: "string",
        description:
          "Freeform detail on what went wrong reading the board — one sentence.",
      },
    },
    required: ["company"],
  },
  parser: z.object({
    company: z.string(),
    status: z.enum(SETTABLE_COMPANY_STATUSES).optional(),
    // The three reason params stay loose strings and are validated in the
    // handler: all three offered lists contain OTHER, so the agent reaches for
    // the wrong param often enough that a stock "Invalid enum value" from the
    // dispatcher (which fires before the handler can explain) is worse than an
    // error naming the param the value belongs to.
    closeReason: z.string().optional(),
    closeNote: z.string().optional(),
    pauseReason: z.string().optional(),
    pauseNote: z.string().optional(),
    blockReason: z.string().optional(),
    blockNote: z.string().optional(),
  }),
  async handle(input, ctx) {
    const {
      company: companySlug,
      status,
      closeReason,
      closeNote,
      pauseReason,
      pauseNote,
      blockReason,
      blockNote,
    } = input;

    // Symmetric reason rejection, same shape as update_job_interaction: a reason
    // paired with a status that doesn't carry it signals the agent is confused
    // about which lever it's pulling, and silently stripping it would hide that.
    // Only checked when a status is passed — a bare closeNote is the legitimate
    // "fix the why on a company that's already closed" case.
    const passedReasons = [
      { status: CompanyStatus.CLOSED, reason: closeReason, note: closeNote },
      { status: CompanyStatus.PAUSED, reason: pauseReason, note: pauseNote },
      { status: CompanyStatus.BLOCKED, reason: blockReason, note: blockNote },
    ] as const;
    if (status !== undefined) {
      for (const pair of passedReasons) {
        const { param } = REASONS_BY_STATUS[pair.status];
        if (status !== pair.status && (pair.reason || pair.note)) {
          return toolError(
            "STATE_CONFLICT",
            `${param}/${param.replace("Reason", "Note")} only apply to status ${pair.status} — you passed status ${status}. Use status ${pair.status} with a ${param}, or drop those fields.`,
            `update_company_interaction:reason_status_mismatch:${pair.status}`,
          );
        }
      }
      const wanted =
        REASONS_BY_STATUS[status as keyof typeof REASONS_BY_STATUS];
      if (wanted) {
        const given = passedReasons.find((p) => p.status === status)?.reason;
        if (!given) {
          return toolError(
            "INVALID_INPUT",
            `status ${status} needs a ${wanted.param} (one of ${wanted.offered.join(", ")}) so the reason is recorded.`,
            `update_company_interaction:missing_reason:${status}`,
          );
        }
      }
    }
    // Validate each reason value against its own offered list, naming the param
    // it actually belongs to when the agent grabbed a sibling list's value.
    for (const pair of passedReasons) {
      if (!pair.reason) continue;
      const { param, offered } = REASONS_BY_STATUS[pair.status];
      if (offered.includes(pair.reason)) continue;
      const sibling = passedReasons.find(
        (other) =>
          other.status !== pair.status &&
          REASONS_BY_STATUS[other.status].offered.includes(pair.reason!),
      );
      const hint = sibling
        ? ` "${pair.reason}" is a ${REASONS_BY_STATUS[sibling.status].param} value — use that param with status ${sibling.status} if that's what you meant.`
        : "";
      return toolError(
        "INVALID_INPUT",
        `"${pair.reason}" isn't a valid ${param} — use one of ${offered.join(", ")}.${hint}`,
        `update_company_interaction:invalid_reason:${param}`,
      );
    }

    // Guard against the wrong-entity confusion in the other direction from
    // update_job_interaction's: resolve the company slug first, and if it's
    // actually a ROLE, say so and name the tool that handles roles.
    const companyResolved = await resolveCompanyBySlug(ctx.userId, companySlug);
    if (!companyResolved.ok) {
      const job = await prisma.job.findFirst({
        where: { OR: [{ slug: companySlug }, { id: companySlug }] },
        select: { title: true },
      });
      if (job) {
        return toolError(
          "ENTITY_NOT_FOUND",
          `"${companySlug}" is a ROLE ("${job.title}"), not a company. To correct a role's stored status or its close/hold reason, use update_job_interaction.`,
          "update_company_interaction:wrong_entity:job_id",
        );
      }
      return slugLookupError(companyResolved, {
        source: "update_company_interaction",
      });
    }
    const companyId = companyResolved.value.id;

    // The watchlist row is what carries status + reasons, so it has to exist.
    // Correcting a record must never quietly ADD a company to the watchlist.
    const existing = await prisma.companyInteraction.findUnique({
      where: { userId_companyId: { userId: ctx.userId, companyId } },
      select: { status: true },
    });
    if (!existing) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `${companyResolved.value.name} isn't on the watchlist, so there's no status to correct. Add it with create_companies first.`,
        "update_company_interaction:not_tracked:company",
      );
    }
    // A bare reason with no status is the "fix the why" case — it only makes
    // sense against the status the company is ALREADY in.
    if (status === undefined) {
      for (const pair of passedReasons) {
        if (!pair.reason && !pair.note) continue;
        if (existing.status === pair.status) continue;
        const { param } = REASONS_BY_STATUS[pair.status];
        return toolError(
          "STATE_CONFLICT",
          `${companyResolved.value.name} is ${existing.status}, not ${pair.status} — a bare ${param} only fixes the why on a company already in that status. Pass status ${pair.status} too if that's the change you mean.`,
          `update_company_interaction:reason_status_mismatch:${pair.status}`,
        );
      }
    }

    const applied = await updateCompanyInteraction(ctx.userId, companyId, {
      status,
      closeReason: closeReason as CompanyCloseReason | undefined,
      closeNote,
      pauseReason: pauseReason as CompanyPauseReason | undefined,
      pauseNote,
      blockReason: blockReason as CompanyBlockReason | undefined,
      blockNote,
    });
    if (applied.length === 0) {
      return { content: "no fields to update" };
    }
    // Restate the no-event contract on every call — same reasoning as the job
    // twin: the description gets skimmed, this lands where Hank decides what to
    // tell the user, and "I closed them out" after a silent correction is the
    // failure it exists to prevent.
    return {
      content: `updated ${companyResolved.value.slug ?? companyId} fields: ${applied.join(", ")}. Record corrected only — NOTHING was added to this company's activity feed, no roles changed, no re-scan. If this was something that just happened rather than a wrong record, use the real lever instead: close_company / pause_company / block_company / caught_up_company.`,
    };
  },
};
