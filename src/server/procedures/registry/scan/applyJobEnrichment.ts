// Persist an enrichment onto the global `Job` row, and decide which display
// columns the extracted scalars are allowed to backfill.
//
// The backfill policy is the domain rule here, not plumbing:
//   - comp / employmentType / department are ADDITIVE — filled only when the
//     scraped column is empty. Never overwrite scraped truth with an inference.
//   - `locationAndArrangement` is the deliberate exception: it may enrich a
//     present-but-incomplete scraped value by folding in the WORK ARRANGEMENT.
//     A bare scraped city ("Toronto, Canada") reads as possibly-remote
//     downstream when the body actually pins it on-site — the exact mismatch
//     that let on-site/hybrid roles slip the geo gate.
//
// Provenance is recorded in `enrichedAttributes.backfilled` so it's visible
// which columns the model wrote versus the scraper.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import type { EnrichScalars } from "@/server/subagents/registry/enrichJob";

// Whether a location string already states a work arrangement, so we don't
// double-tag. Covers remote / hybrid / on-site / onsite / in-office.
function conveysArrangement(s: string | null): boolean {
  return !!s && /\bremote\b|\bhybrid\b|\bon-?site\b|\bin-office\b/i.test(s);
}

export type JobEnrichmentTarget = {
  id: string;
  locationAndArrangement: string | null;
  compensation: string | null;
  employmentType: string | null;
  department: string | null;
};

export async function applyJobEnrichment(args: {
  job: JobEnrichmentTarget;
  summary: string;
  scalars: EnrichScalars;
}): Promise<{ backfilled: string[] }> {
  const { job, scalars } = args;
  const backfilled: string[] = [];
  const columnUpdates: Prisma.JobUpdateInput = {};

  // Prefer the enrichment's own place+arrangement string; fall back to the
  // scraped value. The prompt asks the model to bake the arrangement into
  // `scalars.location`; when it knows the arrangement but the chosen string
  // doesn't say it, fold a tag in — never dropping the place.
  let displayLoc = scalars.location ?? job.locationAndArrangement ?? null;
  if (scalars.remote && displayLoc && !conveysArrangement(displayLoc)) {
    const tag =
      scalars.remote === "remote"
        ? "Remote"
        : scalars.remote === "hybrid"
          ? "Hybrid"
          : "On-site";
    displayLoc =
      scalars.remote === "remote"
        ? `Remote · ${displayLoc}`
        : `${displayLoc} · ${tag}`;
  }
  // Write the column when it's empty, OR when we're ADDING arrangement info the
  // scraped value lacked. That's what turns a confirmed-on-site "Toronto,
  // Canada" into "Toronto, Canada · On-site" instead of leaving it misleadingly
  // bare.
  const addsArrangement =
    !!scalars.remote && !conveysArrangement(job.locationAndArrangement);
  if (
    displayLoc &&
    displayLoc !== job.locationAndArrangement &&
    (!job.locationAndArrangement || addsArrangement)
  ) {
    columnUpdates.locationAndArrangement = displayLoc;
    backfilled.push("locationAndArrangement");
  }

  if (!job.compensation && scalars.comp) {
    columnUpdates.compensation = scalars.comp;
    backfilled.push("compensation");
  }
  if (!job.employmentType && scalars.employmentType) {
    columnUpdates.employmentType = scalars.employmentType;
    backfilled.push("employmentType");
  }
  if (!job.department && scalars.department) {
    columnUpdates.department = scalars.department;
    backfilled.push("department");
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      enrichedSummary: args.summary,
      enrichedAttributes: {
        ...scalars,
        backfilled,
      },
      ...columnUpdates,
    },
  });

  return { backfilled };
}
