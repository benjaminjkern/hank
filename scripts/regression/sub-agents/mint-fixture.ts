// Mint a regression fixture from a REAL prod case.
//
// The loop-closer for the sub-agent eval harness: when prod surfaces a quality
// bug (the shortlist over-selects, the decider mis-routes a question), don't
// hand-author a synthetic fixture from memory — point this script at the actual
// row and paste the stub it prints into the matching audit file. Over time the
// fixture set becomes the real failure distribution, not guesses.
//
// It is READ-ONLY (no writes, no LLM calls) and prints a fixture skeleton you
// then edit: fill in the `expect` + `pins`/`mustShortlist` and (for shortlist)
// the injected persona, since those encode the JUDGEMENT the fixture pins. The
// candidate-facing data (titles, scan verdicts, summaries, form questions) is
// copied verbatim from the DB so the fixture matches what the sub-agent saw.
//
// Usage:
//   pnpm tsx scripts/regression/sub-agents/mint-fixture.ts shortlist --company=<companyId> [--user=<email>]
//   pnpm tsx scripts/regression/sub-agents/mint-fixture.ts decider   --job=<jobId>
//
// Find the companyId / jobId from an over_selection AdminNote (context block),
// the session dump, or the right-panel. Mirrors the pool query shortlistJobsSubAgent
// uses and the form read applicationDeciderSubAgent uses, so the stub is faithful.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  PrismaClient,
  JobInteractionStatus,
} from "../../../src/generated/prisma/client";
import {
  isStockFieldType,
  type ApplicationQuestion,
  type ApplicationQuestionsEnvelope,
} from "../../../src/server/scrape/types";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}
function q(s: string | null | undefined): string {
  return JSON.stringify(s ?? "");
}

async function resolveUserId(): Promise<string> {
  const email =
    arg("user") ?? process.env.AUDIT_USER_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
  const user = email
    ? await prisma.user.findFirst({ where: { email } })
    : await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
      });
  if (!user) throw new Error("no user found (pass --user=<email>)");
  return user.id;
}

async function mintShortlist(): Promise<void> {
  const companyId = arg("company");
  if (!companyId) throw new Error("shortlist needs --company=<companyId>");
  const userId = await resolveUserId();

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  if (!company) throw new Error(`no company ${companyId}`);

  // Mirror shortlistJobsSubAgent's detail-candidate pool query.
  const jobs = await prisma.job.findMany({
    where: {
      companyId,
      jobInteractions: {
        some: {
          userId,
          status: {
            in: [
              JobInteractionStatus.SCANNED,
              JobInteractionStatus.SHORTLISTED,
            ],
          },
        },
      },
    },
    select: {
      title: true,
      locationAndArrangement: true,
      compensation: true,
      enrichedSummary: true,
      rawContent: true,
      jobInteractions: {
        where: { userId },
        select: { matchBucket: true, matchScore: true, matchReason: true },
        take: 1,
      },
    },
  });
  if (jobs.length === 0)
    throw new Error(
      `no SCANNED/SHORTLISTED jobs at ${company.name} for this user`,
    );

  const lines = jobs.map((j, i) => {
    const it = j.jobInteractions[0];
    const summary = (j.enrichedSummary ?? j.rawContent ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 220);
    const comp = j.compensation ? `, ${q(j.compensation)}` : "";
    return `      dj("j${i + 1}", ${q(j.title)}, ${q(j.locationAndArrangement ?? "")}, ${q(it?.matchBucket ?? "POSSIBLE")}, ${q(it?.matchReason ?? "")}, ${q(summary)}${comp}),`;
  });

  const slug = company.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  process.stdout.write(
    [
      `\n// --- Paste into FIXTURES in scripts/regression/sub-agents/shortlist-jobs.ts ---`,
      `// Source: ${company.name} (${companyId}), ${jobs.length} jobs in pool.`,
      `// EDIT: pick the persona (THESIS_PLATFORM/RESUME_PLATFORM or add one), then`,
      `//       write expect/mustShortlist/mustNotShortlist/maxShortlist to pin the call.`,
      `  {`,
      `    name: ${q(`prod-${slug}`)},`,
      `    notes: "minted from prod — EDIT this and the expectation below.",`,
      `    companyName: ${q(company.name)},`,
      `    pool: [`,
      ...lines,
      `    ],`,
      `    expect:`,
      `      "EDIT: describe the correct picks for this pool.",`,
      `    mustShortlist: [],`,
      `    mustNotShortlist: [],`,
      `    maxShortlist: 5,`,
      `  },`,
      ``,
    ].join("\n"),
  );
}

async function mintDecider(): Promise<void> {
  const jobId = arg("job");
  if (!jobId) throw new Error("decider needs --job=<jobId>");

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      title: true,
      applicationQuestions: true,
      company: { select: { name: true, slug: true } },
    },
  });
  if (!job) throw new Error(`no job ${jobId}`);

  const env = job.applicationQuestions as ApplicationQuestionsEnvelope | null;
  const qs: ApplicationQuestion[] =
    env?.status === "ok" && Array.isArray(env.questions) ? env.questions : [];
  const wantsCover =
    ((env?.status === "ok" || env?.status === "empty") &&
      env.coverLetter === true) ||
    qs.some((x) => /\bcover\s*letter\b/i.test(x.question));

  // Show how each question is auto-classified now, so the dev sees which ones
  // the LLM actually decides (the rest are deterministic skips) and where to pin.
  const annotated = qs.map((x) => {
    const pre = isStockFieldType(x.type) ? "skip(type — pre-skipped)" : "→ LLM";
    return `//   [${pre}] (type=${x.type ?? "?"}) ${x.question}`;
  });

  process.stdout.write(
    [
      `\n// --- Paste into FIXTURES in scripts/regression/sub-agents/application-decider.ts ---`,
      `// Source: ${job.title} @ ${job.company?.name} (job ${jobId})`,
      `// Form: ${qs.length} questions${wantsCover ? " + cover letter" : ""}. Auto-classification:`,
      ...annotated,
      `// EDIT: pick the injected persona + write pins for the questions that reach the LLM`,
      `//       (or pin a deterministic skip as a regression guard, like reddit-stock-text-fields-skip).`,
      `  {`,
      `    name: "prod-${job.company?.slug ?? "job"}",`,
      `    notes: "minted from prod — EDIT this and the pins below.",`,
      `    jobId: ${q(jobId)},`,
      `    inject: {`,
      `      profile: mergeProfile(THESIS_BACKEND, VOICE_DIRECT),`,
      `      frequentQ: null,`,
      `      companyNote: ${q(`${job.company?.name} — EDIT.`)},`,
      `      jobNote: null,`,
      `      resume: RESUME_BACKEND_NO_OBS,`,
      `      memoryPaths: ["profile.md"],`,
      `      pastDrafts: NO_DRAFTS,`,
      `    },`,
      `    expect: "EDIT: describe the correct verdicts.",`,
      `    pins: [`,
      `      // { contains: "...", verdict: "skip", why: "..." },`,
      `    ],`,
      wantsCover ? `    coverLetterExpect: "not_skip",` : ``,
      `  },`,
      ``,
    ]
      .filter((l) => l !== ``)
      .join("\n"),
  );
}

async function main() {
  const kind = process.argv[2];
  if (kind === "shortlist") await mintShortlist();
  else if (kind === "decider") await mintDecider();
  else
    throw new Error(
      `usage: mint-fixture.ts <shortlist|decider> --company=<id>|--job=<id>`,
    );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
