import { prisma } from "@/server/db/prisma";
import { readResumeBackground } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";

// What the match pass weighs every role against. Identical for every job at one
// company, so the fan-out loads it once rather than once per sub-agent call.
export type ScanContext = {
  profile: string;
  resume: string;
  companyDescription: string | null;
  companyNote: string | null;
  companyNotePath: string | null;
};

export async function loadScanContext(
  userId: string,
  companyId: string,
): Promise<ScanContext> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { slug: true, description: true },
  });
  const companyNotePath = company?.slug ? `companies/${company.slug}.md` : null;

  const [profile, resume, companyNote] = await Promise.all([
    readMemory(userId, "profile.md"),
    readResumeBackground(userId),
    companyNotePath
      ? readMemory(userId, companyNotePath)
      : Promise.resolve(null),
  ]);

  return {
    profile: (profile ?? "").trim(),
    resume,
    companyDescription: company?.description ?? null,
    companyNote,
    companyNotePath,
  };
}
