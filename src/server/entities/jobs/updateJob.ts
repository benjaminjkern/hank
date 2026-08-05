// Domain core for editing a Job's scalar fields. Shared behind the update_job
// tool: owns the sourceUrl-collision guard, the companyName-clear invariant
// (linking a real Company clears the freeform name so the two can't drift), the
// field diff, and the write. Works purely in ids — the agent's job/company slug
// → id translation is the tool layer's job. Mirror of
// entities/opportunities/updateOpportunity.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { roleAttrColumnPatch, type RoleAttrs } from "./roleAttrs";

// The canonical role attributes are patch-shaped here: an absent key means
// "leave it", an explicit null clears the column.
export type UpdateJobPatch = Partial<RoleAttrs> & {
  // undefined = leave unchanged; null = detach; id = link to that Company. A
  // non-null value clears companyName (name lives on the Company row from here).
  linkCompanyId?: string | null;
  companyName?: string | null;
  title?: string;
  sourceUrl?: string | null;
  rawContent?: string | null;
};

export type UpdateJobResult =
  | { ok: true; appliedFields: string[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "source_url_conflict"; conflictSlugOrId: string };

export async function updateJob(args: {
  jobId: string;
  patch: UpdateJobPatch;
}): Promise<UpdateJobResult> {
  const { jobId, patch } = args;

  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, sourceUrl: true, companyId: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  // Changing sourceUrl to a non-null value that a different row already holds
  // would violate the unique constraint — surface it as a clean conflict.
  if (patch.sourceUrl && patch.sourceUrl !== existing.sourceUrl) {
    const collision = await prisma.job.findUnique({
      where: { sourceUrl: patch.sourceUrl },
      select: { id: true, slug: true },
    });
    if (collision && collision.id !== existing.id) {
      return {
        ok: false,
        reason: "source_url_conflict",
        conflictSlugOrId: collision.slug ?? collision.id,
      };
    }
  }

  const data: Prisma.JobUncheckedUpdateInput = {};
  if (patch.linkCompanyId !== undefined) {
    data.companyId = patch.linkCompanyId;
    // Setting a real companyId auto-clears companyName — name lives on the
    // Company row from here on, and dual sources would drift.
    if (patch.linkCompanyId) data.companyName = null;
  }
  // Apply explicit companyName only when a non-null company isn't being set
  // (otherwise it was just auto-cleared above).
  if (patch.companyName !== undefined && !patch.linkCompanyId) {
    data.companyName = patch.companyName;
  }
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.sourceUrl !== undefined) data.sourceUrl = patch.sourceUrl;
  if (patch.rawContent !== undefined) data.rawContent = patch.rawContent;
  Object.assign(data, roleAttrColumnPatch(patch));

  const appliedFields = Object.keys(data);
  if (appliedFields.length === 0) return { ok: true, appliedFields };

  await prisma.job.update({ where: { id: existing.id }, data });
  return { ok: true, appliedFields };
}
