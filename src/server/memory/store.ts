import { splitSections } from "@/utils/markdown";

import { prisma } from "../db/prisma";

import { slugify, validatePath } from "./paths";

export async function readMemory(
  userId: string,
  path: string,
): Promise<string | null> {
  validatePath(path);
  const row = await prisma.memoryNote.findUnique({
    where: { userId_path: { userId, path } },
    select: { content: true },
  });
  return row?.content ?? null;
}

// Batch read — one query for many paths, returned keyed by path (a path with no
// note is simply absent). A caller holding N paths must use this: N readMemory
// calls is N round trips.
export async function readMemories(
  userId: string,
  paths: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Map();
  for (const path of unique) validatePath(path);
  const rows = await prisma.memoryNote.findMany({
    where: { userId, path: { in: unique } },
    select: { path: true, content: true },
  });
  return new Map(rows.map((r) => [r.path, r.content]));
}

export async function writeMemory(
  userId: string,
  path: string,
  content: string,
): Promise<void> {
  const info = validatePath(path);
  const fk = await resolveFK(userId, info);
  await prisma.memoryNote.upsert({
    where: { userId_path: { userId, path } },
    update: { content, ...fk },
    create: { userId, path, content, ...fk },
  });
}

export async function appendMemory(
  userId: string,
  path: string,
  content: string,
): Promise<void> {
  const existing = await readMemory(userId, path);
  const next = existing ? `${existing.trimEnd()}\n\n${content}` : content;
  await writeMemory(userId, path, next);
}

// Replace (or insert) a single `## heading` section in a note, preserving every
// other section. `section` is the heading text (with or without leading `#`s);
// `body` is the new content for that section (the `## heading` line is added if
// `body` doesn't already start with one). Returns whether an existing section
// was matched (false = the section was newly appended). This is the sanctioned
// "update part of profile.md / resume.md" path — see the write_memory tool's
// load-bearing guard, and the consolidator's `section` write mode.
export async function mergeMemorySection(
  userId: string,
  path: string,
  section: string,
  body: string,
): Promise<{ matched: boolean }> {
  const heading = section.trim().replace(/^#+\s*/, "");
  const bodyTrimmed = body.trim();
  const newRaw = bodyTrimmed.startsWith("##")
    ? bodyTrimmed
    : `## ${heading}\n${bodyTrimmed}`;
  const existing = (await readMemory(userId, path)) ?? "";
  if (!existing.trim()) {
    await writeMemory(userId, path, `${newRaw}\n`);
    return { matched: false };
  }
  const normalized = heading.toLowerCase();
  const { preamble, sections } = splitSections(existing);
  let matched = false;
  const nextSections = sections.map((s) => {
    if (!matched && s.heading.toLowerCase() === normalized) {
      matched = true;
      return { heading: s.heading, raw: newRaw };
    }
    return s;
  });
  if (!matched) nextSections.push({ heading, raw: newRaw });
  const rebuilt =
    [preamble.trim(), ...nextSections.map((s) => s.raw.trim())]
      .filter(Boolean)
      .join("\n\n") + "\n";
  await writeMemory(userId, path, rebuilt);
  return { matched };
}

export async function listMemories(
  userId: string,
  prefix?: string,
): Promise<string[]> {
  const rows = await prisma.memoryNote.findMany({
    where: { userId, ...(prefix ? { path: { startsWith: prefix } } : {}) },
    select: { path: true },
    orderBy: { path: "asc" },
  });
  return rows.map((r) => r.path);
}

// Build a slug-based memory path from an internal id — for server callers that
// hold a jobId/opportunityId (sub-agents, loaders) but must address the note by
// its slug. Falls back to the id only for a slug-less legacy entity.
export async function jobNotePath(jobId: string): Promise<string> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { slug: true },
  });
  return `jobs/${job?.slug ?? jobId}.md`;
}

export async function opportunityNotePath(
  opportunityId: string,
): Promise<string> {
  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { slug: true },
  });
  return `opportunities/${opp?.slug ?? opportunityId}.md`;
}

type FK = {
  companyId?: string;
  jobId?: string;
  opportunityId?: string;
  contactId?: string;
};

async function resolveFK(
  userId: string,
  info: ReturnType<typeof validatePath>,
): Promise<FK> {
  if (info.kind === "company") {
    const company = await prisma.company.findUnique({
      where: { slug: info.slug },
      select: { id: true },
    });
    return company ? { companyId: company.id } : {};
  }
  if (info.kind === "job") {
    // Accept slug OR legacy cuid so pre-migration paths still populate the FK.
    const job = await prisma.job.findFirst({
      where: { OR: [{ slug: info.slug }, { id: info.slug }] },
      select: { id: true },
    });
    return job ? { jobId: job.id } : {};
  }
  if (info.kind === "opportunity") {
    const opportunity = await prisma.opportunity.findFirst({
      where: { userId, OR: [{ slug: info.slug }, { id: info.slug }] },
      select: { id: true },
    });
    return opportunity ? { opportunityId: opportunity.id } : {};
  }
  if (info.kind === "contact") {
    // Match a Contact whose slugified name equals the path slug. Scoped to the
    // user so two users with same-named contacts don't collide. Returns the
    // first match — if a user has duplicate Contact names this is best-effort.
    const candidates = await prisma.contact.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    const match = candidates.find((c) => slugify(c.name) === info.slug);
    return match ? { contactId: match.id } : {};
  }
  return {};
}
