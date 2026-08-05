import "dotenv/config";
import { scrapeUrl } from "../../src/server/scrape";
import { closeHeadless } from "../../src/server/platform/browser/headless";

const url = process.argv[2] ?? "https://job-boards.greenhouse.io/gleanwork";

async function main() {
  console.log(`Scraping ${url}…`);
  const t = Date.now();
  const r = await scrapeUrl(url);
  const ms = Date.now() - t;
  console.log(`took ${ms}ms`);
  if (!r.ok) {
    console.error("scrape error:", r.error);
    process.exit(1);
  }
  console.log(`company: ${r.data.companyName}`);
  console.log(`jobs: ${r.data.jobs.length}`);
  for (const j of r.data.jobs.slice(0, 5)) {
    console.log(`  - ${j.title} (${j.sourceUrl})`);
    console.log(`    rawContent: ${j.rawContent.slice(0, 100)}…`);
  }
  if (r.data.jobs.length > 5)
    console.log(`  …and ${r.data.jobs.length - 5} more`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  // The headless Chromium singleton keeps the event loop alive; without this
  // an all-pass run never exits.
  .finally(() => closeHeadless());
