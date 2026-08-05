import "dotenv/config";
import { scrapeUrl } from "../../src/server/scrape";
import {
  extractGreenhouseSlugFromBoardUrl,
  fetchApplicationQuestions,
} from "../../src/server/scrape/ats";

// One sample board per ATS — picked because each has live openings as of
// 2026-06-08 and has been used to smoke-test the scraper. Swap a slug here
// if the company closes hiring later.
//
// Greenhouse-custom is a second Greenhouse row: Databricks (and Stripe, W&B,
// CoreWeave) host their board on Greenhouse but the boards-api response
// returns each job's `absolute_url` on the company's own domain with a
// `?gh_jid=` query param. The scraper has to recover the slug from
// Company.greenhouseSlug at apply-form time; this canary asserts that path
// keeps working. Don't drop this row when refreshing the matrix.
// `expectForm` (default "present") declares the form-questions baseline for the
// board. "present" → the check passes on ok/empty (the form scraper works).
// "unsupported" → the ATS has no unauthenticated questions endpoint and the
// check passes ONLY while it stays unsupported — so the row doubles as a drift
// canary: if the provider ever exposes a public form (status flips to ok/empty)
// the row goes red, prompting someone to wire the questions parser.
// `expectDetail` (default "full") sets the detail-content baseline. "full" →
// first job's rawContent must be a real description (>200 chars). "list-only" →
// the provider can only get titles + metadata (e.g. Meta, whose per-job
// description is login/JS-gated), so a short rawContent is expected; we just
// assert it's non-empty.
const BOARDS: Array<{
  ats: string;
  url: string;
  expectForm?: "present" | "unsupported";
  expectDetail?: "full" | "list-only";
}> = [
  { ats: "Greenhouse", url: "https://job-boards.greenhouse.io/figma" },
  { ats: "Greenhouse-custom", url: "https://boards.greenhouse.io/databricks" },
  { ats: "Lever", url: "https://api.lever.co/v0/postings/spotify?mode=json" },
  { ats: "Ashby", url: "https://jobs.ashbyhq.com/linear" },
  {
    ats: "Workday",
    url: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site",
  },
  { ats: "Teamtailor", url: "https://storytel.teamtailor.com/jobs" },
  { ats: "Gem", url: "https://jobs.gem.com/gem" },
  // Single-tenant career site (amazon.jobs hosts Amazon + AWS/Audible/Ring/…).
  // base_query is forwarded to search.json so this scopes to engineering roles.
  {
    ats: "Amazon",
    url: "https://www.amazon.jobs/en/search?base_query=engineer",
    expectForm: "unsupported",
  },
  // Bosch publishes full posting bodies via the public API (Visa returns empty
  // default job-ads — a bad sample). 4.6k postings also exercises the cap.
  {
    ats: "SmartRecruiters",
    url: "https://jobs.smartrecruiters.com/BoschGroup",
    expectForm: "unsupported",
  },
  { ats: "Workable", url: "https://apply.workable.com/huggingface/" },
  // Eightfold (Bayer), Rippling (Cars & Bids board), Oracle ORC (Oracle's own
  // careers site). All three: list+detail work; questions are unsupported
  // (Eightfold redirects applications to the underlying ATS; Rippling's form is
  // SPA-gated; Oracle's apply is hCaptcha/login-gated).
  {
    ats: "Eightfold",
    url: "https://bayer.eightfold.ai/careers",
    expectForm: "unsupported",
  },
  {
    ats: "Rippling",
    url: "https://ats.rippling.com/cars-and-bids-job-board/jobs",
    expectForm: "unsupported",
  },
  {
    ats: "Oracle",
    url: "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions",
    expectForm: "unsupported",
  },
  // Apple: single-tenant, React-Router SSR (job data in window.__staticRouterHydrationData).
  // Apply requires an Apple ID sign-in → questions unsupported.
  {
    ats: "Apple",
    url: "https://jobs.apple.com/en-us/search?sort=newest",
    expectForm: "unsupported",
  },
  // JazzHR (ProAutomated board): server-rendered HTML + ld+json detail + token-free
  // questions endpoint. Full list/detail/questions, all plain fetch.
  { ats: "JazzHR", url: "https://proautomated.applytojob.com/apply/jobs/" },
  // iCIMS career-site (Jibe) JSON API on a branded custom domain. List + full
  // detail bundled in `{origin}/api/jobs`; apply flow is login-gated → questions
  // unsupported. Discovered from a careers page via resolveBoardFromCareersPage.
  {
    ats: "iCIMS",
    url: "https://careers.amd.com/api/jobs",
    expectForm: "unsupported",
  },
  // The last four are headless-rendered SPAs (slow — list render + capped detail
  // renders). Single-tenant; apply flows login-gated → questions unsupported.
  {
    ats: "Shopify",
    url: "https://www.shopify.com/careers/search",
    expectForm: "unsupported",
  },
  // Meta: list-only (GraphQL list via headless capture; per-job description is
  // login/JS-gated, so rawContent is title + locations + teams). Google + Netflix
  // are also wired (headless) but intentionally have NO matrix row: Google's
  // rendered results are bot-detection-flaky and Netflix exposes no job URLs, so
  // both return an honest error rather than a reliable canary result.
  {
    ats: "Meta",
    url: "https://www.metacareers.com/jobs",
    expectForm: "unsupported",
    expectDetail: "list-only",
  },
];

type Row = {
  ats: string;
  list: string;
  detail: string;
  meta: string;
  form: string;
};

function tick(ok: boolean, note: string): string {
  return `${ok ? "PASS" : "FAIL"} ${note}`;
}

async function verify(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const {
    ats,
    url,
    expectForm = "present",
    expectDetail = "full",
  } of BOARDS) {
    process.stdout.write(`\n=== ${ats} (${url}) ===\n`);
    // 1) LIST
    const t1 = Date.now();
    const scrape = await scrapeUrl(url);
    const listMs = Date.now() - t1;
    if (!scrape.ok) {
      rows.push({
        ats,
        list: tick(false, `scrape error: ${scrape.error}`),
        detail: "skipped (list failed)",
        meta: "skipped (list failed)",
        form: "skipped (list failed)",
      });
      continue;
    }
    const jobs = scrape.data.jobs;
    const listOk = jobs.length > 0;
    process.stdout.write(`list: ${jobs.length} jobs in ${listMs}ms\n`);

    // 2) DETAIL — first job's rawContent should be a real description, not a stub.
    // 200 chars is a conservative lower bound that catches "title only" hallucinations.
    const first = jobs[0];
    const rawLen = first?.rawContent?.length ?? 0;
    const detailOk = expectDetail === "list-only" ? rawLen > 20 : rawLen > 200;
    process.stdout.write(
      `detail: first job "${first?.title}" rawContent=${rawLen} chars\n`,
    );
    process.stdout.write(
      `        snippet: ${(first?.rawContent ?? "").slice(0, 120).replace(/\n/g, " ")}…\n`,
    );

    // 3) META — structured location must survive parsing. The entire Ashby
    // provider once silently emitted location=null/"Remote" for every job
    // because parseAshby read field names absent from the posting API; list +
    // detail + form all still passed, so nothing caught it (fixed 2026-06-12).
    // A real board always tags some role with a concrete city — an all-null /
    // all-"Remote" result is the corruption signature for this class of bug.
    const realLoc = jobs.filter(
      (j) => j.location && j.location.toLowerCase() !== "remote",
    );
    const metaOk = realLoc.length > 0;
    process.stdout.write(
      `meta:   ${realLoc.length}/${jobs.length} jobs with a concrete location\n`,
    );

    // 4) FORM — fetchApplicationQuestions should return ok/empty (anything but
    // error/unsupported). Some boards have no custom questions — empty is fine.
    // For Greenhouse boards we pass the slug hint the same way the
    // get_application_form tool does in prod (read from Company.greenhouseSlug);
    // that's load-bearing for the Greenhouse-custom row whose per-job URL is
    // on a non-greenhouse.io host.
    const t3 = Date.now();
    const greenhouseSlug = extractGreenhouseSlugFromBoardUrl(url);
    const form = await fetchApplicationQuestions(first.sourceUrl, {
      greenhouseSlug,
    });
    const formMs = Date.now() - t3;
    // "present" boards must scrape a form (ok/empty). "unsupported" boards are
    // expected to have no public questions endpoint — they pass only while they
    // stay unsupported (a flip to ok/empty is a signal to wire the parser).
    const formOk =
      expectForm === "unsupported"
        ? form.status === "unsupported"
        : form.status === "ok" || form.status === "empty";
    let formDetail = `${form.status}${expectForm === "unsupported" ? " (expected)" : ""}`;
    if (form.status === "ok")
      formDetail += `, ${form.questions.length} questions`;
    else if (form.status === "error") formDetail += `: ${form.error}`;
    process.stdout.write(`form:   ${formDetail} in ${formMs}ms\n`);
    if (form.status === "ok" && form.questions.length > 0) {
      const q = form.questions[0];
      process.stdout.write(
        `        first q: "${q.question.slice(0, 100)}"${q.required ? " (required)" : ""}\n`,
      );
    }

    rows.push({
      ats,
      list: tick(listOk, `${jobs.length} jobs / ${listMs}ms`),
      detail: tick(detailOk, `${rawLen} chars rawContent`),
      meta: tick(metaOk, `${realLoc.length}/${jobs.length} located`),
      form: tick(formOk, `${formDetail} / ${formMs}ms`),
    });
  }
  return rows;
}

async function main() {
  const rows = await verify();
  process.stdout.write("\n\n=== SUMMARY ===\n");
  const pad = (s: string, n: number) =>
    s + " ".repeat(Math.max(0, n - s.length));
  process.stdout.write(
    `${pad("ATS", 18)}${pad("LIST", 24)}${pad("DETAIL", 28)}${pad("META", 22)}FORM\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.ats, 18)}${pad(r.list, 24)}${pad(r.detail, 28)}${pad(r.meta, 22)}${r.form}\n`,
    );
  }
  const failed = rows.filter((r) =>
    [r.list, r.detail, r.meta, r.form].some((c) => c.startsWith("FAIL")),
  );
  if (failed.length === 0) {
    process.stdout.write(`\nAll ${rows.length * 4} checks passed.\n`);
  } else {
    process.stdout.write(
      `\n${failed.length} ATS(es) had failures: ${failed.map((r) => r.ats).join(", ")}\n`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
