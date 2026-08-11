// Offline regression for the generic probe's inference core: does an array of
// objects look like a list of job postings, and which key holds what?
//
// No network, no DB, no LLM, no `.env` — free to run, and the fastest signal we
// have on the piece where a mistake is SILENT. A false positive here doesn't
// error; it produces a scrape full of navigation links that looks like a
// working board, so the negative cases below matter at least as much as the
// positive ones.
//
//   pnpm ats:jobshape

import {
  findJobArray,
  looksLikeJobArray,
  type JobKeyMapping,
} from "../../src/server/scrape/generic/jobShape";
import { parseFeedItems } from "../../src/server/scrape/generic/feed";
import { harvestBlobs } from "../../src/server/scrape/generic/blobs";
import { boardIdentifiesCompany } from "../../src/server/entities/boardReaders/boardIdentity";
import { boardPathScope } from "../../src/server/scrape/generic/sitemap";

type Case = {
  name: string;
  // What the detector is handed: a bare array, or a nested blob to search.
  value: unknown;
  search?: "array" | "blob";
  expect: "accept" | "reject";
  // Asserted only on accept, and only for the keys named.
  keys?: Partial<JobKeyMapping>;
  // Asserted only on accept: dot path of the winning array within a blob.
  path?: string;
};

// A believable posting row, varied enough that distinctness checks pass.
function jobs(n: number, over: Partial<Record<string, unknown>> = {}) {
  const titles = [
    "Senior Backend Engineer",
    "Staff Product Designer",
    "Engineering Manager, Payments",
    "Data Scientist II",
    "Site Reliability Engineer",
    "Technical Writer",
    "Solutions Architect",
    "Security Engineer",
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: `req-${1000 + i}`,
    title: titles[i % titles.length] + (i >= titles.length ? ` ${i}` : ""),
    absolute_url: `https://boards.example.com/acme/jobs/${1000 + i}`,
    location: { name: i % 2 === 0 ? "Remote — US" : "Berlin, DE" },
    department: i % 3 === 0 ? "Engineering" : "Design",
    ...over,
  }));
}

const CASES: Case[] = [
  // -- accepts ---------------------------------------------------------------
  {
    name: "greenhouse-shaped rows",
    value: jobs(8),
    expect: "accept",
    keys: { title: "title", identity: "absolute_url", identityIsUrl: true },
  },
  {
    name: "opaque id + slug, no url column",
    value: Array.from({ length: 6 }, (_, i) => ({
      id: 40_000 + i,
      name: `Product Manager ${i}`,
      slug: `product-manager-${i}`,
      city: "London",
      employmentType: "Full-time",
    })),
    expect: "accept",
    keys: { title: "name", identityIsUrl: false },
  },
  {
    name: "long descriptions are the corroborating signal on their own",
    value: Array.from({ length: 4 }, (_, i) => ({
      jobId: `J-${i}`,
      jobTitle: `Analyst ${i}`,
      url: `https://x.example.com/j/${i}`,
      description: `We are looking for an analyst. ${"Responsibilities include reporting and modelling. ".repeat(6)}`,
    })),
    expect: "accept",
    keys: { title: "jobTitle", description: "description" },
  },
  {
    name: "exactly two postings (the MIN_REAL_JOBS floor)",
    value: jobs(2),
    expect: "accept",
  },
  {
    name: "nested location object maps to its text leaf",
    value: jobs(5),
    expect: "accept",
    keys: { location: "location" },
  },

  // -- rejects ---------------------------------------------------------------
  {
    name: "nav menu — titles are site chrome",
    value: [
      { name: "Home", href: "/" },
      { name: "About", href: "/about" },
      { name: "Careers", href: "/careers" },
      { name: "Contact", href: "/contact" },
      { name: "Blog", href: "/blog" },
    ],
    expect: "reject",
  },
  {
    name: "department filter list — no corroborating column, thin objects",
    value: [
      { id: 1, name: "Engineering" },
      { id: 2, name: "Design" },
      { id: 3, name: "Sales" },
      { id: 4, name: "Marketing" },
    ],
    expect: "reject",
  },
  {
    name: "breadcrumbs",
    value: [
      { position: 1, name: "Home", item: "https://x.com/" },
      { position: 2, name: "Jobs", item: "https://x.com/jobs" },
    ],
    expect: "reject",
  },
  {
    name: "array of bare strings",
    value: ["Engineering", "Design", "Sales", "Marketing"],
    expect: "reject",
  },
  {
    name: "single posting — a template 'Open Application' entry",
    value: jobs(1),
    expect: "reject",
  },
  {
    name: "every title identical",
    value: Array.from({ length: 5 }, (_, i) => ({
      title: "Open Application",
      url: `https://x.example.com/${i}`,
      location: "Remote",
    })),
    expect: "reject",
  },
  {
    name: "repeated titles below the distinctness floor",
    value: Array.from({ length: 10 }, (_, i) => ({
      title: i < 8 ? "Software Engineer" : `Designer ${i}`,
      url: `https://x.example.com/${i}`,
      location: "Remote",
    })),
    expect: "reject",
  },
  {
    name: "duplicate ids — identity column doesn't identify",
    value: Array.from({ length: 6 }, (_, i) => ({
      title: `Engineer ${i}`,
      id: "same",
      location: "Remote",
    })),
    expect: "reject",
  },
  {
    name: "titles are URLs — a link list, not a board",
    value: Array.from({ length: 5 }, (_, i) => ({
      title: `https://x.example.com/page-${i}`,
      url: `https://x.example.com/page-${i}`,
      location: "Remote",
    })),
    expect: "reject",
  },
  {
    name: "no title-ish column at all",
    value: Array.from({ length: 5 }, (_, i) => ({
      ref: `A${i}`,
      url: `https://x.example.com/${i}`,
      city: "Berlin",
    })),
    expect: "reject",
  },
  {
    name: "short summaries don't corroborate (card subtitles, not bodies)",
    value: Array.from({ length: 5 }, (_, i) => ({
      title: `Role ${i} Engineer`,
      url: `https://x.example.com/${i}`,
      summary: "Join our team",
    })),
    expect: "reject",
  },
  {
    name: "empty array",
    value: [],
    expect: "reject",
  },

  // -- blob search -----------------------------------------------------------
  {
    name: "__NEXT_DATA__ holding both a nav array and the board",
    search: "blob",
    value: {
      props: {
        pageProps: {
          nav: [
            { name: "Home", href: "/" },
            { name: "About", href: "/about" },
            { name: "Careers", href: "/careers" },
          ],
          jobs: jobs(12),
        },
      },
    },
    expect: "accept",
    path: "props.pageProps.jobs",
    keys: { title: "title", identity: "absolute_url" },
  },
  {
    name: "board nested under a paginated envelope",
    search: "blob",
    value: { data: { results: jobs(5), meta: { total: 5 } } },
    expect: "accept",
    path: "data.results",
  },
  {
    name: "blob with nothing job-shaped in it",
    search: "blob",
    value: {
      props: { pageProps: { locales: ["en", "de"], flags: { beta: true } } },
    },
    expect: "reject",
  },
];

// Feed + blob extraction have their own small fixtures, since they're the
// front half of the same pipeline and equally offline.
const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Acme Jobs</title>
  <item>
    <title>Senior Backend Engineer</title>
    <link>https://acme.example.com/jobs/senior-backend-engineer</link>
    <description><![CDATA[<p>We need a backend engineer. ${"Details follow. ".repeat(15)}</p>]]></description>
    <location>Remote — US</location>
  </item>
  <item>
    <title>Staff Product Designer</title>
    <link>https://acme.example.com/jobs/staff-product-designer</link>
    <description><![CDATA[<p>We need a designer. ${"Details follow. ".repeat(15)}</p>]]></description>
    <location>Berlin, DE</location>
  </item>
  <item>
    <title>Data Scientist</title>
    <link>https://acme.example.com/jobs/data-scientist</link>
    <description><![CDATA[<p>We need a scientist. ${"Details follow. ".repeat(15)}</p>]]></description>
    <location>Remote — EU</location>
  </item>
</channel></rss>`;

const NEXT_DATA_FIXTURE = `<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { jobs: jobs(4) } },
})}</script>
<script>window.__NUXT__ = {"state":{"openings":${JSON.stringify(jobs(3))}}};</script>
</body></html>`;

// The multi-tenant guard. A sitemap lives at the ORIGIN, but on a VC or
// accelerator job board one PATH is one company — so a board scoped to a path
// must never collect its neighbours' postings. Both of these were observed
// filing another company's jobs under the wrong company before the scope
// existed, so they're pinned here.
const SCOPE_CASES: Array<{ url: string; expect: string }> = [
  // Host is the company and the board is AT the origin → no siblings to steal
  // from, so the whole origin is in scope.
  { url: "https://jobs.wordpress.net/", expect: "/" },
  { url: "https://careers.example.com", expect: "/" },
  // A single path segment is genuinely ambiguous — it's a section of the
  // company's own site here, but a tenant on `board.com/acme`. It scopes,
  // because the two failure modes are not symmetric: scoping too tightly makes
  // this tier decline and the others still try, while scoping too loosely files
  // someone else's postings under this company and nothing later notices.
  { url: "https://example.com/careers", expect: "/careers/" },
  // Multi-tenant. The tenant segment is LAST here and MIDDLE in the next one —
  // which is why the scope is the board's whole path and never a parent of it.
  {
    url: "https://jobs.madrona.com/companies/fixie-ai",
    expect: "/companies/fixie-ai/",
  },
  {
    url: "https://www.ycombinator.com/companies/shaped/jobs",
    expect: "/companies/shaped/jobs/",
  },
  { url: "not a url", expect: "/" },
];

function runScopeChecks(): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const c of SCOPE_CASES) {
    const got = boardPathScope(c.url);
    if (got === c.expect) {
      pass++;
      console.log(`  PASS  ${c.url} → ${got}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.url} → ${got}, expected ${c.expect}`);
    }
  }
  return { pass, fail };
}

// The aggregator guard. Every URL here came out of a real backfill run — the
// rejected ones were stored as working readers before this existed, and one of
// them was filing other employers' jobs under a watchlisted company.
const IDENTITY_CASES: Array<{
  name: string;
  url: string;
  samples?: string[];
  accept: boolean;
}> = [
  { name: "Betches Media", url: "https://careers.betches.com/", accept: true },
  { name: "Liner", url: "https://liner.com/careers/jobs", accept: true },
  {
    name: "Uber",
    url: "https://www.uber.com/global/en/careers/list/",
    accept: true,
  },
  // The host is a job-board host, but the PATH names the company, which is what
  // a per-company section on a shared host looks like.
  {
    name: "The Female Quotient",
    url: "https://jenniejohnson.com/company/the-female-quotient",
    accept: true,
  },
  // Company site fronting Ashby: the postings live on a host that never
  // mentions the company, and that's normal — the ATS carve-out covers it.
  {
    name: "Shade Inc.",
    url: "https://shade.inc/careers",
    samples: ["https://jobs.ashbyhq.com/shade-inc/abc"],
    accept: true,
  },
  {
    name: "Sourcegraph",
    url: "https://boards.greenhouse.io/sourcegraph91",
    samples: ["https://boards.greenhouse.io/sourcegraph91/jobs/1"],
    accept: true,
  },
  // THE FAILURE THIS EXISTS FOR: a LatAm aggregator listing many employers.
  // Same host, postings under the board's own path, distinct URLs, real titles
  // — every other check passes, and the jobs belong to other companies.
  {
    name: "Whym",
    url: "https://worklatam.com/jobs",
    samples: ["https://worklatam.com/jobs/532869450-customer-support"],
    accept: false,
  },
  {
    name: "Acme",
    url: "https://jobs.example-aggregator.com/jobs",
    accept: false,
  },
];

function runIdentityChecks(): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const c of IDENTITY_CASES) {
    const r = boardIdentifiesCompany({
      companyName: c.name,
      boardUrl: c.url,
      ...(c.samples ? { sampleJobUrls: c.samples } : {}),
    });
    if (r.ok === c.accept) {
      pass++;
      console.log(`  PASS  ${c.name} — ${r.ok ? "accepted" : "rejected"}`);
    } else {
      fail++;
      console.log(
        `  FAIL  ${c.name} — ${r.ok ? "accepted" : "rejected"}, expected ${c.accept ? "accept" : "reject"}`,
      );
    }
  }
  return { pass, fail };
}

function runExtractionChecks(): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    if (ok) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name} — ${detail}`);
    }
  };

  const feedItems = parseFeedItems(RSS_FIXTURE);
  check(
    "RSS feed parses to 3 items",
    feedItems?.length === 3,
    `got ${feedItems?.length ?? "null"}`,
  );
  const feedMatch = feedItems ? looksLikeJobArray(feedItems) : null;
  check(
    "RSS items read as a job array via <link>",
    feedMatch?.keys.identity === "link",
    `identity=${feedMatch?.keys.identity ?? "none"}`,
  );

  const harvested = harvestBlobs(NEXT_DATA_FIXTURE);
  check(
    "harvests both __NEXT_DATA__ and the __NUXT__ assignment",
    harvested.some((b) => b.spec.kind === "script-id") &&
      harvested.some((b) => b.spec.kind === "assignment"),
    harvested.map((b) => b.label).join(", ") || "nothing",
  );
  const fromBlob = harvested
    .map((b) => findJobArray(b.value))
    .find((m) => m != null);
  check(
    "finds the postings inside a harvested blob",
    fromBlob != null,
    "no job array found",
  );

  return { pass, fail };
}

function main(): void {
  let pass = 0;
  let fail = 0;

  console.log("\njob-shape detection\n");
  for (const c of CASES) {
    const match =
      c.search === "blob" ? findJobArray(c.value) : looksLikeJobArray(c.value);
    const accepted = match != null;
    const wanted = c.expect === "accept";

    if (accepted !== wanted) {
      fail++;
      console.log(
        `  FAIL  ${c.name} — expected ${c.expect}, got ${accepted ? "accept" : "reject"}`,
      );
      continue;
    }

    const problems: string[] = [];
    if (match) {
      if (c.path != null && match.path !== c.path) {
        problems.push(`path ${match.path} != ${c.path}`);
      }
      for (const [key, want] of Object.entries(c.keys ?? {})) {
        const got = match.keys[key as keyof JobKeyMapping];
        if (got !== want)
          problems.push(`${key} ${String(got)} != ${String(want)}`);
      }
    }
    if (problems.length > 0) {
      fail++;
      console.log(`  FAIL  ${c.name} — ${problems.join("; ")}`);
    } else {
      pass++;
      console.log(`  PASS  ${c.name}`);
    }
  }

  console.log("\nextraction\n");
  const extraction = runExtractionChecks();
  pass += extraction.pass;
  fail += extraction.fail;

  console.log("\nsitemap path scope\n");
  const scope = runScopeChecks();
  pass += scope.pass;
  fail += scope.fail;

  console.log("\nboard identity (aggregator guard)\n");
  const identity = runIdentityChecks();
  pass += identity.pass;
  fail += identity.fail;

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
