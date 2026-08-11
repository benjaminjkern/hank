// Board-recipe recon sub-agent (judgement class).
//
// Given a careers URL the deterministic probe couldn't crack, work out HOW to
// read it and emit a declarative plan — never the postings themselves. That
// distinction is the entire safety argument for this feature: the model
// describes a locator, the runner fetches, and a hallucinated job posting is
// structurally impossible rather than merely unlikely.
//
// It never sees the page's HTML. The caller hands it a structural digest
// (scrape/generic/pageEvidence.ts) — blob outlines, script URLs, a DOM
// skeleton, a sitemap summary — because 300KB of markup is both unaffordable
// and worse signal than a 400-character outline of the array the board is
// sitting in.
//
// Judgement-class rather than a one-shot transform because the answer is
// verified by DOING: `test_recipe` runs the candidate against the live board,
// and what comes back (0 postings / identical titles / duplicate URLs) tells
// the model which single field to fix. Without that loop it would be guessing
// with no feedback, which is how you get a plan that looks right and reads a
// nav menu.
//
// Runs at most ONCE per board, ever — shared by every company on it, skipped
// whenever the free probe succeeded, and cooldown-gated on failure. That is
// what makes the capable model the obviously correct choice here.

import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { fetchUrlTool } from "@/server/agent/tools/registry/fetchUrl";
import { testRecipeTool } from "@/server/agent/tools/registry/testRecipe";
import type { LlmModel } from "@/server/platform/llm/models";
import type { PageEvidence } from "@/server/scrape/generic/pageEvidence";
import type { BoardRecipe } from "@/server/scrape/recipe/types";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// pro, not flash: this runs once per board and its artifact is permanent and
// shared, so the marginal cost of the capable model is amortized over every
// future scrape of that board — while a wrong plan is re-paid forever.
const MODEL: LlmModel = "deepseek-v4-pro";
const MAX_TOKENS = 4096;
// With the evidence front-loaded a healthy run commits in 2-3 turns. The
// headroom is for the iterate-on-test_recipe case, which is the point of the
// loop.
const MAX_TURNS = 8;

export type BoardRecipeInput = {
  companyName: string;
  evidence: PageEvidence;
};

export type BoardRecipeOutput =
  | { outcome: "recipe"; recipe: BoardRecipe; jobCount: number; note: string }
  // The postings only exist after client-side render. Prod can't run a browser;
  // scripts/ats/research-board.ts can, locally, and authors a recipe from what
  // the page's own XHR revealed.
  | { outcome: "needs_browser"; note: string }
  | { outcome: "needs_auth"; note: string }
  | { outcome: "exhausted"; note: string };

const REPORT_BOARD_RECIPE_SCHEMA: SubAgentOutputSchema = {
  name: "report_board_recipe",
  description:
    "Emit the recon outcome. Use outcome='recipe' ONLY for a recipe you ran through test_recipe and saw return real postings — never one you believe should work. Use 'needs_browser' when the postings demonstrably arrive after client-side render (no list in the HTML, no JSON endpoint, no feed, no sitemap of postings). Use 'needs_auth' when the board is behind a login or an anti-bot wall. Use 'exhausted' when you tried everything available and none of it read the board.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["recipe", "needs_browser", "needs_auth", "exhausted"],
      },
      recipe: {
        type: "object",
        description:
          "Required when outcome='recipe'. The exact recipe object test_recipe accepted — copy it verbatim, don't retype it from memory.",
      },
      jobCount: {
        type: "number",
        description:
          "Required when outcome='recipe'. How many postings test_recipe returned on the run you are reporting.",
      },
      note: {
        type: "string",
        description:
          "One or two sentences an engineer will read when deciding whether this board deserves a hand-written provider. For 'recipe': where the postings live and how the URL is built. For every other outcome: what you tried and what specifically blocked it (e.g. 'the list is fetched by /api/search with a POST body signed client-side'). Plain description of the BOARD — no internal jargon, no apologies.",
      },
    },
    required: ["outcome", "note"],
  },
};

type BoardRecipeEmission = {
  outcome?: string;
  recipe?: unknown;
  jobCount?: number;
  note?: string;
};

export const boardRecipeSubAgent: SubAgentDef<
  BoardRecipeInput,
  BoardRecipeEmission,
  BoardRecipeOutput
> = {
  name: "board_recipe",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Before you emit an outcome, say which piece of evidence you are mapping from and quote the exact key path for every field. Name the array you believe holds the postings and the path that reaches it, then the key that holds the title and the key that identifies the posting — and say whether that identifier is already a URL or has to be built into one. If you are reporting a recipe, name the test_recipe run that proved it: how many postings came back and whether the sample titles look like real role titles rather than page chrome. If you are reporting anything else, list what you actually tried; an untried technique from the list in your instructions means you are not done.",
  },
  maxTurns: MAX_TURNS,
  system: buildSystemPrompt,
  userContent: buildInitialUserContent,
  readTools: [testRecipeTool as AnyToolDef, fetchUrlTool as AnyToolDef],
  outputSchema: REPORT_BOARD_RECIPE_SCHEMA,
  caption: (input) => `working out how to read ${input.companyName}'s board…`,
  usageNotes: (input, turn) => `turn=${turn} company=${input.companyName}`,
  parse: validateOutput,
};

// A structurally-wrong emission THROWS — runSubAgent turns that into an
// ordinary {ok:false}, so a `recipe` outcome with no recipe never reaches the
// caller that would persist it.
function validateOutput(emission: BoardRecipeEmission): BoardRecipeOutput {
  const note = emission.note?.trim() ?? "(no note given)";
  if (emission.outcome === "recipe") {
    if (emission.recipe == null || typeof emission.recipe !== "object") {
      throw new Error(
        "board_recipe emitted outcome=recipe without a recipe object",
      );
    }
    return {
      outcome: "recipe",
      recipe: emission.recipe as BoardRecipe,
      jobCount: emission.jobCount ?? 0,
      note,
    };
  }
  if (
    emission.outcome === "needs_browser" ||
    emission.outcome === "needs_auth" ||
    emission.outcome === "exhausted"
  ) {
    return { outcome: emission.outcome, note };
  }
  throw new Error(
    `board_recipe emitted invalid outcome: ${JSON.stringify(emission.outcome)}`,
  );
}

function buildSystemPrompt(): string {
  return `You work out how to read a company job board that none of our wired scrapers recognize. You produce a RECIPE — a small declarative plan describing where the postings live and which key holds each field. You never produce job postings themselves: the recipe is executed by a deterministic runner, and that is what keeps invented postings impossible.

# What you are given

A structural digest of the board's page, not the page. It contains:
- **probe report** — the deterministic techniques already tried and what each returned. Anything listed there has already failed; don't propose it again unaltered.
- **JSON blob outlines** — every JSON payload embedded in the page, as a shape sketch: key names, value types, one sample value each, array lengths. **This is usually where the answer is.** A board's own data is nearly always sitting in the HTML already.
- **inline-script URLs** — API-ish URLs found in the page's scripts. Often the endpoint the page itself calls.
- **DOM skeleton** — repeated element structures with class names and a sample, for when the board is plain server-rendered HTML.
- **head links + sitemap summary** — feeds, and how many URLs look like postings.

# The recipe format

\`\`\`json
{
  "version": 1,
  "list": { ... },
  "itemsPath": "dot.path.to.the.postings.array",
  "fields": {
    "title":      { "path": "title" },
    "sourceUrl":  { "path": "absolute_url" },
    "rawContent": { "path": "descriptionHtml", "transform": ["html-to-text"] },
    "location":   { "path": "location.name" },
    "department": { "path": "team.name" },
    "compensation": { "path": "salaryRange" },
    "employmentType": { "path": "employmentType" }
  },
  "detail": { "extract": { "kind": "page" } },
  "familyKey": "short-name-for-this-board-software"
}
\`\`\`

**\`list\` — where the postings come from.** One of:
- \`{"kind":"json","url":"https://…","method":"GET"}\` — a JSON endpoint. Best when available. \`method\`/\`body\`/\`headers\` are optional; a POST body must be a fixed string (a board that signs or paginates through its body is out of scope — report \`needs_browser\`).
- \`{"kind":"embedded","url":"<the page>","blob":{"kind":"script-id","id":"__NEXT_DATA__"}}\` — pull a JSON blob out of the page's HTML. Other blob kinds: \`{"kind":"assignment","varName":"window.__NUXT__"}\`, \`{"kind":"flight"}\`, \`{"kind":"attribute","selector":"div[data-page]","attr":"data-page"}\`, \`{"kind":"jsonld","atType":"JobPosting"}\`. The blob outlines tell you the exact address to use — it's printed on each one.
- \`{"kind":"feed","url":"https://…/jobs.rss"}\` — RSS/Atom or a vendor XML feed. Rows are flattened to objects, so their fields use \`path\` like JSON.
- \`{"kind":"html","url":"https://…","rowSelector":"li.job-card"}\` — repeated DOM rows. Last resort: class names churn. Row fields use \`{"selector":"a.title"}\` (text) or \`{"selector":"a","attr":"href","transform":["abs-url"]}\`, and \`":scope"\` addresses the row itself.
- \`{"kind":"sitemap","url":"https://…/sitemap.xml","pathContains":"/jobs/"}\` — the sitemap's URLs ARE the postings. Requires a \`detail\` step, and \`sourceUrl\` is \`{"path":"url"}\`.

**\`itemsPath\`** — dot path from the payload to the postings array. \`""\` when the payload IS the array. Numbers index (\`data.0.jobs\`). Ignored for \`html\`/\`feed\`/\`sitemap\`.

**\`fields\`** — \`title\` and \`sourceUrl\` are required. A field is:
- \`{"path":"key.subkey"}\` — read from the item
- \`{"template":"https://x.com/jobs/{slug}"}\` — build it; \`{...}\` are paths into the same item
- \`{"selector":"...","attr":"href"}\` — HTML rows only
- optional \`"transform"\`: \`trim\`, \`html-to-text\`, \`decode-entities\`, \`join-comma\`, \`first\`, \`abs-url\`

**\`detail\`** — when the list rows carry no body. \`{"extract":{"kind":"page"}}\` (title + text from the posting page — the safe default), \`{"kind":"jsonld","atType":"JobPosting"}\`, \`{"kind":"text"}\`, \`{"kind":"json","path":"data"}\`, or \`{"kind":"selector","selector":"div.description"}\`. The result is merged onto the item as \`detail\`, so fields read it by path: \`{"path":"detail.text"}\`, \`{"path":"detail.0.description"}\`. Add \`"urlTemplate"\` if the detail URL differs from \`sourceUrl\`.

**\`paging\`** — only if one page isn't the whole board: \`{"kind":"page-param","param":"page","start":1,"maxPages":10}\`, \`{"kind":"offset-param","param":"offset","size":100,"maxPages":10}\`, or \`{"kind":"total-count","totalPath":"total","param":"offset","size":100}\`.

**\`listOnly\`** — set true ONLY if the board genuinely publishes no body anywhere.

# sourceUrl is the field you must not get wrong

It becomes the posting's permanent identity in our database. A wrong or unstable one silently orphans records — it does not degrade, it corrupts. So:
- Prefer a field that already holds a full URL.
- A relative path needs \`"transform":["abs-url"]\`.
- Only build a \`template\` from an id/slug when you have CHECKED that the built URL loads (use fetch_url on one).
- Never let a URL carry a page number, offset, cursor, session token or timestamp.
- The URL must be on the board's own domain.

# How to work

1. Read the blob outlines first. Look for an array whose length is plausible for a job board and whose rows have a title-ish key AND an id/url-ish key. That is almost always the answer.
2. Write a candidate recipe and **call test_recipe**. Read what comes back.
3. Fix ONE thing at a time. The failures are specific: 0 postings → wrong \`itemsPath\` or \`list\`; identical titles → the title locator matched page chrome; duplicate/cross-domain URLs → wrong \`sourceUrl\`; bodies too short → you need a \`detail\` step.
4. Use fetch_url to look at one posting page when you need to see what a detail page publishes, or to confirm a URL template resolves.
5. When test_recipe returns real postings with plausible role titles, report it.

# Is this board actually THIS company's?

Some of what looks like a job board is an aggregator, a job-board host, or a VC/accelerator portfolio board — one site listing roles at MANY employers. A recipe that reads one of those is worse than no recipe: it files other companies' postings under this one, and because it scrapes cleanly nothing downstream ever notices.

You are told which company this board is supposed to belong to. **Before reporting a recipe, look at the sample titles test_recipe returned and ask whether they are that company's roles.** Tells that they are not:
- titles naming an employer ("Customer Support at Next Level", "Designer – Hype and Vice")
- postings spread across unrelated industries
- posting URLs under a different company's path on the same host (\`/companies/<someone-else>/…\`)
- far more roles than a company that size would post

If the board lists many employers and you cannot scope the recipe to just this company's postings, report **exhausted** and say it's an aggregator. If you CAN scope it — the company has its own section and the postings live under it — do that, and make sure the sample reflects it.

# Commit as soon as it works

test_recipe returning real postings with plausible role titles for the right company is the finish line — report it then. Don't spend remaining turns polishing field coverage; a recipe with title + URL + body is useful, and an extra attribute is not worth another round trip. Equally, if two or three attempts have shown you the board isn't reachable from this evidence, say so rather than trying variations of a plan that already failed for a structural reason.

# When to report something other than a recipe

- **needs_browser** — you can find no list in the HTML, no JSON endpoint, no feed, and no sitemap of postings. The board is rendered client-side. Say what you looked at.
- **needs_auth** — a login wall, or the page is served by an anti-bot challenge.
- **exhausted** — everything available was tried and nothing read the board.

Reporting one of these is a fine outcome and better than a recipe you haven't verified. What is NOT fine is guessing: an unverified recipe costs more than an honest miss, because it will look like it works.

# What you don't do

- Don't invent, transcribe, or list job postings. Your output is a plan; the runner fetches.
- Don't report a recipe test_recipe hasn't accepted.
- Don't write to memory or the database — your final tool is your only output.
- Don't make multiple final-tool calls; one outcome per run.`;
}

function buildInitialUserContent(input: BoardRecipeInput): string {
  const e = input.evidence;
  const sections = [
    `# Board to read\ncompany: ${input.companyName}\nurl: ${e.url}`,
    `# What the deterministic probe already tried\n${e.probeReport}`,
  ];
  if (!e.fetched) {
    sections.push(
      `# Page fetch\n${e.blobOutlines}\n\nThe page itself could not be fetched. That usually means bot protection rather than a missing board — a feed or a sitemap may still work.`,
    );
  } else {
    sections.push(`# JSON blobs embedded in the page\n${e.blobOutlines}`);
    sections.push(`# API-ish URLs in inline scripts\n${e.scriptUrls}`);
    sections.push(`# Repeated DOM structure\n${e.domSkeleton}`);
    if (e.headLinks)
      sections.push(`# Head links + job-ish anchors\n${e.headLinks}`);
  }
  sections.push(`# Sitemap\n${e.sitemapSummary}`);
  sections.push(
    "Work out how to read this board. Write a candidate recipe, run it through test_recipe, and iterate until it returns real postings — then report it with report_board_recipe. If nothing can read it, report why.",
  );
  return sections.join("\n\n");
}
