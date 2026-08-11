// Everything the pre-scan job-batch sub-agent needs to bucket a company's board:
// the candidate's profile + resume summary, what the company is (its one-line
// description + the user's companies/{slug}.md note — the evidence the domain
// skip reads), and the company's not-yet-judged job pool as lean metadata rows.
// Two hops, not one: the company row is fetched first because its slug is what
// addresses the note.
//
// Split out from the procedure so the sub-agent never reads the DB itself — its
// input IS this context, which is what lets a fixture stand alone.

import { prisma } from "@/server/db/prisma";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { readResumeBackground } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";
import type { PreScanLeanJob } from "@/server/subagents/registry/preScanJobBatch";

import { preScanPoolWhere } from "./pool";

// A lean row plus the jobId the caller maps verdicts back onto. The jobId is
// deliberately NOT part of `PreScanLeanJob` — the model never sees it.
export type PreScanCandidateJob = PreScanLeanJob & { id: string };

export type PreScanContext = {
  companyName: string;
  // What the company does + the user's own note on it. Optional: a fixture
  // supplies neither, and a company added seconds ago has no description yet.
  companyDescription?: string | null;
  companyNote?: string | null;
  companyNotePath?: string | null;
  profile: string | null;
  resume: string;
  jobs: PreScanCandidateJob[];
};

export async function loadPreScanContext(args: {
  userId: string;
  companyId: string;
}): Promise<PreScanContext | null> {
  // Company first: its slug is what addresses the company note, and a missing
  // company short-circuits before the heavier reads.
  const company = await prisma.company.findUnique({
    where: { id: args.companyId },
    select: { name: true, slug: true, description: true },
  });
  if (!company) return null;
  const companyNotePath = company.slug ? `companies/${company.slug}.md` : null;

  const [profile, resume, jobs, companyNote] = await Promise.all([
    readMemory(args.userId, "profile.md"),
    readResumeBackground(args.userId),
    prisma.job
      .findMany({
        where: {
          companyId: args.companyId,
          jobInteractions: {
            some: { userId: args.userId, ...preScanPoolWhere() },
          },
        },
        select: {
          id: true,
          title: true,
          ...ROLE_ATTR_SELECT,
          attributes: true,
          enrichedAttributes: true,
        },
      })
      // The lean shape the fixtures are written in — column names off, canonical
      // attribute names on.
      .then((rows) =>
        rows.map((j) => ({
          id: j.id,
          title: j.title,
          ...toRoleAttrs(j),
          attributes: j.attributes,
          enrichedAttributes: j.enrichedAttributes,
        })),
      ),
    companyNotePath
      ? readMemory(args.userId, companyNotePath)
      : Promise.resolve(null),
  ]);

  return {
    companyName: company.name,
    companyDescription: company.description,
    companyNote,
    companyNotePath,
    profile,
    resume,
    jobs,
  };
}
