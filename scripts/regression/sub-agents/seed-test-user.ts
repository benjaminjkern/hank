// Seed (or re-seed) an isolated prod TEST USER for the audit harness.
//
// Why: the audits need a user with a real profile (thesis/resume) + populated
// pools (SCANNED for shortlist, NEW for pre-scan) + a watchlist + chat history.
// By convention, audits run on prod against a TEST USER (not a real account,
// not the local dev DB). This clones a focused slice of a source admin user's
// prod profile under a dedicated test user so the audits are isolated +
// reproducible and never read or mutate that real account.
//
// Cloned (prod -> prod, reusing global Company/Job rows):
//   - User row (copies the source admin user's encrypted Anthropic key so sub-agent calls run)
//   - ChatSession + last N ChatMessages (compact-summary / memory-consolidation)
//   - Resume
//   - MemoryNotes (overall/users-me/resume/frequent_questions + companies/*),
//     contact/opportunity FKs nulled (test user owns none)
//   - CompanyInteractions (full watchlist — for suggest/discovery rosters)
//   - JobInteractions + Events for the FIXTURE companies only (the pools)
//
// Idempotent: on --apply it wipes the test user's owned rows first, then
// re-creates. Dry-run by default — prints the plan + counts, writes nothing.
//
//   pnpm exec tsx scripts/regression/sub-agents/seed-test-user.ts          # dry-run
//   pnpm exec tsx scripts/regression/sub-agents/seed-test-user.ts --apply  # write

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const TEST_EMAIL = "audit-fixtures@hank.test";
const SOURCE_EMAIL = "admin@example.com";
// Fixture companies whose pools the test user must own (mirror the source admin user's).
const SHORTLIST_SLUGS = [
  "exa",
  "glean",
  "stripe",
  "weights-biases",
  "perplexity-ai",
];
const PRESCAN_SLUGS = ["notion", "spotify", "together-ai", "replit"];
const FIXTURE_SLUGS = [...new Set([...SHORTLIST_SLUGS, ...PRESCAN_SLUGS])];
const MSG_CLONE_COUNT = 60;

const APPLY = process.argv.includes("--apply");

function log(...a: unknown[]) {
  process.stdout.write(a.join(" ") + "\n");
}

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "?";
  log(
    `DB: ${host}   mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`,
  );

  const sourceUser = await prisma.user.findUnique({
    where: { email: SOURCE_EMAIL },
    select: {
      id: true,
      anthropicKeyEncrypted: true,
      anthropicKeyHint: true,
      anthropicKeyUpdatedAt: true,
      canUseServerKey: true,
    },
  });
  if (!sourceUser) throw new Error(`source user ${SOURCE_EMAIL} not found`);

  const fixtureCompanies = await prisma.company.findMany({
    where: { slug: { in: FIXTURE_SLUGS } },
    select: { id: true, slug: true },
  });
  const foundSlugs = new Set(fixtureCompanies.map((c) => c.slug));
  const missing = FIXTURE_SLUGS.filter((s) => !foundSlugs.has(s));
  if (missing.length)
    log(`⚠ fixture companies not in this DB: ${missing.join(", ")}`);

  const shortlistIds = fixtureCompanies
    .filter((c) => SHORTLIST_SLUGS.includes(c.slug))
    .map((c) => c.id);
  const prescanIds = fixtureCompanies
    .filter((c) => PRESCAN_SLUGS.includes(c.slug))
    .map((c) => c.id);
  // --- gather what we'd clone (read-only). Target ONLY the JobInteractions the
  // audits actually query — the shortlist pool (SCANNED|SHORTLISTED events) and
  // the pre-scan pool (NEW status). Cloning every JobInteraction at these companies
  // would be thousands of rows of mostly-irrelevant CLOSED/APPLIED history.
  //
  // A capped slice of CLOSED rows used to come along too, feeding the shortlist
  // context's per-company past-skips lookup. That lookup is gone (see
  // procedures/registry/shortlist/loadShortlistJobsInput.ts), and nothing else
  // reads CLOSED rows off the seeded user — so they're no longer cloned. ---
  const incl = { events: true, job: { select: { companyId: true } } } as const;
  const [resumes, notes, companyInts, shortlistPool, prescanPool, msgs] =
    await Promise.all([
      prisma.resume.findMany({ where: { userId: sourceUser.id } }),
      prisma.memoryNote.findMany({ where: { userId: sourceUser.id } }),
      prisma.companyInteraction.findMany({ where: { userId: sourceUser.id } }),
      prisma.jobInteraction.findMany({
        where: {
          userId: sourceUser.id,
          job: { companyId: { in: shortlistIds } },
          events: { some: { type: { in: ["SCANNED", "SHORTLISTED"] } } },
        },
        include: incl,
      }),
      prisma.jobInteraction.findMany({
        where: {
          userId: sourceUser.id,
          job: { companyId: { in: prescanIds } },
          status: "NEW",
        },
        include: incl,
      }),
      prisma.chatMessage.findMany({
        where: { session: { userId: sourceUser.id } },
        orderBy: { createdAt: "desc" },
        take: MSG_CLONE_COUNT,
      }),
    ]);
  // Dedupe by jobId: the same JobInteraction can be in both pools (a NEW row at a
  // company that's in SHORTLIST_SLUGS too). Cloning it twice trips the
  // (userId, jobId) unique constraint.
  const seenJobIds = new Set<string>();
  const jobInts = [...shortlistPool, ...prescanPool].filter((j) => {
    if (seenJobIds.has(j.jobId)) return false;
    seenJobIds.add(j.jobId);
    return true;
  });
  const cloneNotes = notes.filter(
    (n) =>
      !n.path.startsWith("contacts/") && !n.path.startsWith("opportunities/"),
  );
  const eventCount = jobInts.reduce((s, j) => s + j.events.length, 0);

  // Per-company pool breakdown so the dry-run shows the test user will get the
  // right shape (SCANNED|SHORTLISTED-event pool for shortlist, NEW for pre-scan).
  const slugById = new Map(fixtureCompanies.map((c) => [c.id, c.slug]));
  const byCompany = new Map<string, { scanned: number; neu: number }>();
  for (const j of jobInts) {
    const slug = slugById.get(j.job.companyId ?? "") ?? "?";
    const r = byCompany.get(slug) ?? { scanned: 0, neu: 0 };
    if (j.events.some((e) => e.type === "SCANNED" || e.type === "SHORTLISTED"))
      r.scanned++;
    if (j.status === "NEW") r.neu++;
    byCompany.set(slug, r);
  }

  log("Plan — clone from the source admin user → test user:");
  log(`  Resumes:             ${resumes.length}`);
  log(
    `  MemoryNotes:         ${cloneNotes.length} (of ${notes.length}; skipped contacts/opportunities)`,
  );
  log(`  CompanyInteractions: ${companyInts.length} (full watchlist)`);
  log(`  JobInteractions:     ${jobInts.length} (fixture companies only)`);
  log(`  Events:              ${eventCount}`);
  log(`  ChatMessages:        ${msgs.length} (last ${MSG_CLONE_COUNT})`);
  log("");
  log("  Pool breakdown (slug: scanned / new):");
  for (const slug of FIXTURE_SLUGS) {
    const r = byCompany.get(slug) ?? { scanned: 0, neu: 0 };
    const role = SHORTLIST_SLUGS.includes(slug) ? "shortlist" : "pre-scan";
    log(
      `    ${slug.padEnd(20)} scanned=${String(r.scanned).padStart(3)}` +
        `  new=${String(r.neu).padStart(3)}  (${role})`,
    );
  }
  log("");

  if (!APPLY) {
    log("DRY-RUN complete. Re-run with --apply to write the test user.");
    return;
  }

  // --- APPLY ---
  let test = await prisma.user.findUnique({
    where: { email: TEST_EMAIL },
    select: { id: true },
  });
  if (!test) {
    test = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        name: "Audit Fixtures (test user)",
        isAdmin: false,
        anthropicKeyEncrypted: sourceUser.anthropicKeyEncrypted,
        anthropicKeyHint: sourceUser.anthropicKeyHint,
        anthropicKeyUpdatedAt: sourceUser.anthropicKeyUpdatedAt,
        canUseServerKey: sourceUser.canUseServerKey,
      },
      select: { id: true },
    });
    log(`created test user ${TEST_EMAIL} (${test.id})`);
  } else {
    log(`reusing test user ${TEST_EMAIL} (${test.id}) — wiping owned rows`);
    // Wipe in FK-safe order.
    const sessions = await prisma.chatSession.findMany({
      where: { userId: test.id },
      select: { id: true },
    });
    await prisma.chatMessage.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.chatSession.deleteMany({ where: { userId: test.id } });
    await prisma.jobInteraction.deleteMany({ where: { userId: test.id } }); // cascades events
    await prisma.companyInteraction.deleteMany({ where: { userId: test.id } });
    await prisma.memoryNote.deleteMany({ where: { userId: test.id } });
    await prisma.resume.deleteMany({ where: { userId: test.id } });
    // keep the key fresh in case the source admin user rotated it
    await prisma.user.update({
      where: { id: test.id },
      data: {
        anthropicKeyEncrypted: sourceUser.anthropicKeyEncrypted,
        anthropicKeyHint: sourceUser.anthropicKeyHint,
        anthropicKeyUpdatedAt: sourceUser.anthropicKeyUpdatedAt,
        canUseServerKey: sourceUser.canUseServerKey,
      },
    });
  }
  const testId = test.id;

  // Resumes (the files). What they SAY rides along in the resume.md memory note
  // cloned below, so nothing here re-derives the background.
  for (const r of resumes) {
    await prisma.resume.create({
      data: {
        userId: testId,
        fileName: r.fileName,
        fileMime: r.fileMime,
        fileBytes: r.fileBytes,
      },
    });
  }

  // Memory notes
  for (const n of cloneNotes) {
    await prisma.memoryNote.create({
      data: {
        userId: testId,
        path: n.path,
        content: n.content,
        companyId: n.companyId,
        jobId: n.jobId,
        opportunityId: null,
        contactId: null,
      },
    });
  }

  // CompanyInteractions (full watchlist)
  for (const c of companyInts) {
    await prisma.companyInteraction.create({
      data: {
        userId: testId,
        companyId: c.companyId,
        status: c.status,
        closeReason: c.closeReason,
        closeNote: c.closeNote,
        pauseReason: c.pauseReason,
        pauseNote: c.pauseNote,
        lastScrapedJobsAt: c.lastScrapedJobsAt,
        lastDiscussedAt: c.lastDiscussedAt,
      },
    });
  }

  // JobInteractions + events (fixture companies)
  for (const j of jobInts) {
    const created = await prisma.jobInteraction.create({
      data: {
        userId: testId,
        jobId: j.jobId,
        status: j.status,
        closeReason: j.closeReason,
        closeNote: j.closeNote,
        matchBucket: j.matchBucket,
        matchScore: j.matchScore,
        matchReason: j.matchReason,
        deferReason: j.deferReason,
        deferNote: j.deferNote,
        coverLetter: j.coverLetter,
        shortAnswers: j.shortAnswers ?? undefined,
        opportunityId: null, // test user owns no opportunities
      },
      select: { id: true },
    });
    if (j.events.length) {
      await prisma.jobEvent.createMany({
        data: j.events.map((e) => ({
          jobInteractionId: created.id,
          type: e.type,
          occurredAt: e.occurredAt,
          notes: e.notes,
          source: e.source,
        })),
      });
    }
  }

  // Chat session + messages (chronological)
  const session = await prisma.chatSession.create({
    data: { userId: testId },
    select: { id: true },
  });
  const chrono = [...msgs].reverse();
  for (const m of chrono) {
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: m.role,
        content: m.content ?? [],
        createdAt: m.createdAt,
      },
    });
  }

  log(
    `\n✓ Seeded test user ${TEST_EMAIL}: resumes=${resumes.length}, notes=${cloneNotes.length}, ` +
      `companies=${companyInts.length}, jobInts=${jobInts.length}, events=${eventCount}, msgs=${msgs.length}`,
  );
  log(
    `Run audits with:  AUDIT_USER_EMAIL=${TEST_EMAIL} pnpm exec tsx scripts/regression/sub-agents/<name>.ts --live`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
