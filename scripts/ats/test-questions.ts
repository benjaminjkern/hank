import "dotenv/config";
import { fetchApplicationQuestions } from "../../src/server/scrape/ats";

const url = process.argv[2];
if (!url) {
  console.error("usage: pnpm tsx scripts/test-questions.ts <job url>");
  process.exit(1);
}

async function main() {
  console.log(`Fetching application questions for ${url}…`);
  const t = Date.now();
  const r = await fetchApplicationQuestions(url);
  const ms = Date.now() - t;
  console.log(`took ${ms}ms, status: ${r.status}`);
  if (r.status === "ok") {
    console.log(`questions: ${r.questions.length}`);
    for (const q of r.questions.slice(0, 8)) {
      const meta = [q.required ? "required" : null, q.type]
        .filter(Boolean)
        .join(", ");
      console.log(`  - "${q.question}"${meta ? ` (${meta})` : ""}`);
    }
    if (r.questions.length > 8)
      console.log(`  …and ${r.questions.length - 8} more`);
  } else if (r.status === "error") {
    console.error("error:", r.error);
  } else {
    console.log("(no further fields)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
