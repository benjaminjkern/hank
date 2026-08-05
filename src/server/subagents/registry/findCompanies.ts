// Find-companies sub-agent — the single "grow the watchlist" engine.
//
// Merges the two former sub-agents (suggestCompanies = memory-only synthesis,
// discoverySearch = web_search discovery) into one. Given the user's thesis +
// resume + their EXISTING watchlist (names + statuses + why-set-aside), plus an
// optional free-text `direction` the main agent forwards from chat, it returns a
// list of candidate company names with a one-line reason each. It has web_search
// + fetch_url available and DECIDES whether to use them — a well-understood
// thesis can be answered from knowledge; a fresh/narrow direction wants a search.
//
// Surface-level only: it does NOT validate fit beyond "the name plausibly
// matches." The main agent shows the candidates in a company_checklist; approved
// names feed the add-to-watchlist enrich pipeline (URL hunt → scrape → PRE_SCAN
// → scan → shortlist), which is where the real per-company filtering happens.
//
// The watchlist is BOTH a dedup list AND positive/negative signal: companies the
// user is actively pursuing pull suggestions toward their shape; companies they
// closed (with the close reason) push suggestions away from that shape.

import { CompanyStatus } from "@/generated/prisma/client";
import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { fetchUrlTool } from "@/server/agent/tools/registry/fetchUrl";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

import type Anthropic from "@anthropic-ai/sdk";

// Grow-the-watchlist sub-agent. Web search self-grounds (candidates trace to
// real results) and the memory-synthesis half matched the top tier, so flash is
// the pin. Re-audit if quality slips.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 4096;
const MAX_TURNS = 12;
const MAX_WEB_SEARCH_USES = 10;

// One watchlist row as the sub-agent sees it: the company name, how the user is
// engaging with it (status), and — for a set-aside row — the structured why.
export type WatchlistContextEntry = {
  name: string;
  status: CompanyStatus;
  // Freeform "why set aside" line (close/pause/block reason + note), when the
  // status carries one. Absent for active/neutral rows.
  reason?: string;
};

// What the search works from. Assembled by the caller
// (entities/companies/loadFindCompaniesInput.ts) — this sub-agent reads
// nothing itself. web_search still hits the real web, which is the point: the
// candidates it surfaces are real companies.
export type FindCompaniesInput = {
  profile: string | null;
  resume: string;
  // Every company already on the user's list: a dedup constraint AND signal
  // (what they're pursuing, what they set aside and why).
  watchlist: WatchlistContextEntry[];
  // Free-text steer the main agent forwards from chat ("more early-stage infra",
  // "remote-first climate companies", "actually look for devtools instead").
  // Optional — with no direction the search works from the thesis alone.
  direction?: string;
  count?: number;
};

export type FindCompaniesCandidate = {
  name: string;
  oneLineReason: string;
  // The canonical careers/ATS board URL the search surfaced for this company,
  // when the sub-agent is confident it's THIS company's board.
  // Carried through the checklist into the URL hunter as a "verify this first"
  // candidate so the hunter doesn't re-guess a slug and can't resolve a name
  // collision to the wrong company. Absent when it didn't see a board URL it
  // trusts (memory-synthesis candidates never carry one).
  url?: string;
};

export type FindCompaniesOutput = {
  candidates: FindCompaniesCandidate[];
  // The scratchpad, carried through rather than dropped. Prod reads only
  // `candidates`; this is here because the account it holds — searched vs.
  // worked-from-knowledge, and which claim traces to which result — is the only
  // record of WHY a candidate is believed real, and fabrication is this
  // sub-agent's documented failure mode. The audit harness grades against it.
  analysis: string | null;
};

const COMMIT_CANDIDATES_SCHEMA: SubAgentOutputSchema = {
  name: "commit_candidates",
  description:
    "Emit the final list of candidate companies for the user to approve. Each candidate is a name + a one-line reason. Don't over-curate — surface anything that plausibly matches; the user prunes from there. 5-15 candidates is the typical sweet spot.",
  inputSchema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                'Canonical brand name as the user would recognize it ("Cognition Labs", not "cognition-ai").',
            },
            oneLineReason: {
              type: "string",
              description:
                'Why this is on the list. One sentence, plain English (no enum codes / path references — the user reads it). "Backend-heavy fintech raising Series B; payments-infra roles match the user\'s thesis."',
            },
            url: {
              type: "string",
              description:
                "Optional. The company's canonical careers/ATS board URL IF a search result showed you one you're confident belongs to THIS company (e.g. jobs.lever.co/<slug>, boards.greenhouse.io/<slug>, jobs.ashbyhq.com/<slug>, or the company's own /careers). This disambiguates name collisions (two real \"Runway\" companies) and saves the downstream URL hunt. OMIT it rather than guess — a wrong URL is worse than none. Don't fabricate a slug you didn't see.",
            },
          },
          required: ["name", "oneLineReason"],
        },
      },
    },
    required: ["candidates"],
  },
};

type CommitCandidatesInput = {
  candidates?: Array<{ name?: string; oneLineReason?: string; url?: string }>;
  // Injected by the runner from `reasoning` — see FindCompaniesOutput.analysis.
  analysis?: string;
};

// Turn a company's stored status into how the sub-agent should read it: what the
// user is actively pursuing (positive signal), what's just on the list, and what
// they set aside + why (negative / context signal).
type WatchlistBucket = "pursuing" | "watching" | "setAside";
function bucketForStatus(status: CompanyStatus): WatchlistBucket {
  switch (status) {
    case CompanyStatus.APPLYING:
    case CompanyStatus.READY:
      return "pursuing";
    case CompanyStatus.CLOSED:
    case CompanyStatus.PAUSED:
    case CompanyStatus.BLOCKED:
      return "setAside";
    default:
      // NEW / CAUGHT_UP — on the list, neutral.
      return "watching";
  }
}

function renderUserContent(input: FindCompaniesInput): string {
  const direction = input.direction?.trim() || "";
  const { watchlist } = input;
  const pursuing = watchlist.filter(
    (w) => bucketForStatus(w.status) === "pursuing",
  );
  const watching = watchlist.filter(
    (w) => bucketForStatus(w.status) === "watching",
  );
  const setAside = watchlist.filter(
    (w) => bucketForStatus(w.status) === "setAside",
  );
  const rosterLine = (w: WatchlistContextEntry) =>
    `- ${w.name}${w.reason ? ` — ${w.reason}` : ""}`;

  return [
    "# Candidate profile (profile.md)",
    input.profile?.trim() || "(empty — lean on the direction + resume)",
    "",
    "# The candidate's background",
    input.resume,
    "",
    direction
      ? `# User direction this turn (steer HARD from this)\n${direction}\n`
      : "",
    "# The user's current watchlist — signal, not just a dedup list",
    "Everything below is ALREADY on the list — never re-suggest any of them.",
    pursuing.length
      ? `\n## Actively pursuing (surface MORE companies shaped like these)\n${pursuing.map(rosterLine).join("\n")}`
      : "",
    watching.length
      ? `\n## Watching (on the list, neutral)\n${watching.map(rosterLine).join("\n")}`
      : "",
    setAside.length
      ? `\n## Set aside (steer AWAY from close matches — the reason says why)\n${setAside.map(rosterLine).join("\n")}`
      : "",
    watchlist.length === 0
      ? "(empty watchlist — no dedup constraints yet)"
      : "",
    "",
    `# Target candidate count: ${input.count ?? 10} (sweet spot 5-15)`,
    "",
    "Decide whether you need the web: a well-understood thesis you can answer from knowledge doesn't need a search; a fresh, narrow, or time-sensitive direction (recent funding, 'who's hiring now', an unfamiliar niche) does. When you have a solid list, call commit_candidates.",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_PROMPT = `You are the company-finder sub-agent for a chat-first job application tool. Given a user's search thesis + resume + their existing watchlist (and often a free-text direction from the chat), you surface companies they probably haven't tracked yet that look like a plausible fit.

# What you're doing

Surface-level discovery. Generate a list of candidate **company names** (NOT specific roles or jobs) with a one-line reason each. The user reviews and prunes; approved names feed the add-to-watchlist pipeline, where the deeper work (URL hunt, scan, PRE_SCAN, deep check) happens. You are NOT validating fit beyond "the name plausibly matches." If a company looks promising on the surface, surface it — downstream steps filter the noise.

# Use the web when it helps — but you don't have to

You have web_search (${MAX_WEB_SEARCH_USES}-use budget) and fetch_url. Decide per run:
- **Search** when the direction is fresh, narrow, or time-sensitive ("who's hiring backend now", recent Series-B raises, an unfamiliar niche), or when you'd otherwise be guessing at whether a company exists / its stage.
- **Work from knowledge** when the thesis maps to companies you're confident are real and currently operating (well-trodden sectors). A recognizable, verifiable name beats an obscure one you searched up but can't vouch for.
- You can mix: knowledge for the obvious names, a couple of searches to fill in fresh or niche ones.

In \`analysis\`, say which you did.

# The watchlist is signal, not just a dedup list

The context front-loads the user's current watchlist in three buckets:
- **Actively pursuing** — lean IN. Surface more companies shaped like these (same sector / stage / role-density).
- **Watching** — neutral, just already on the list.
- **Set aside** — each carries WHY. A *fit* reason (wrong stage, off-thesis, comp too low) is a real signal: steer AWAY from close matches. A *technical* reason ("couldn't read their board") is NOT a fit judgment — ignore it for shaping.
Never re-suggest anything already on the list (any bucket).

# Direction-shape — when the user asks for a role/job-shape, return COMPANIES that fit

The direction is free-form and the user often phrases it as a role ("engineering manager roles at Series A/B AI startups", "remote backend roles"). You still return companies — translate the role-shape into "what kinds of companies hire that role":
- "engineering manager roles at Series A/B AI startups" → Series A/B AI startups with eng teams large enough to need EMs (~15+ engineers).
- "remote backend roles" → remote-first / remote-friendly companies with backend-heavy products.
- "staff IC at climate tech" → climate companies past Series B (small ones have no staff level yet).
Acknowledge the translation in \`analysis\`.

# Strategy

1. Read the thesis + direction + watchlist buckets. Form the target shape.
2. Search (or recall) for on-thesis companies. Mix angles: sector+stage+hiring, tech-stack, role-specific, direction-specific.
3. Optionally fetch_url a relevant hiring page / aggregator (levels.fyi, a curated list).
4. Deduplicate against the watchlist (front-loaded; case-insensitive).
5. Trim: don't surface giants the user obviously knows (Google, Microsoft) unless the thesis calls for them; don't surface off-thesis companies just because a search returned them.
6. Aim for 5-15 candidates. Fewer is fine for a narrow thesis; more than 20 is noise.

# Output

Call commit_candidates with:
- candidates: [{name, oneLineReason, url?}] — name as the user would recognize it; oneLineReason explains plausible fit in plain English.
- **url (optional, per candidate):** if a search result showed you the company's own careers/ATS board URL and you're confident it belongs to THIS company, include it — it disambiguates name collisions (two real "Runway") and skips a re-hunt. OMIT rather than guess; never fabricate a slug.
- In \`analysis\`: searched vs. worked-from-knowledge, any direction you translated, why you cut off.

# Discipline

- Don't read job descriptions to validate fit. Surface-level only.
- **Every company you emit from a SEARCH must trace to an actual web_search / fetch_url result in THIS run.** Never state a funding round or dollar amount you didn't read — do not estimate or invent figures. A "$150M seed" you can't cite is a fabrication: drop the company or omit the claim.
- When working from knowledge, only emit companies you're **confident are real and currently operating.** If unsure a name exists (or you might be conflating two), reach for a clearly-real one instead. A shorter, grounded list beats a padded one.
- **Honor the direction's hard constraints — don't pad to a count.** When the direction names a stage band ("Series A/B") or a hard filter ("remote-first"), only emit companies that match. Returning FEWER on-target companies is correct; note any shortfall in \`analysis\` rather than diluting the list. A single off-band exception is acceptable only if you flag it explicitly in its reason.
- One factual sentence per reason. Don't editorialize about strong-vs-weak fit; let the user decide.`;

export const findCompaniesSubAgent: SubAgentDef<
  FindCompaniesInput,
  CommitCandidatesInput,
  FindCompaniesOutput
> = {
  name: "find_companies",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  // Written BEFORE the list, so accounting for the search shapes it rather than
  // documenting one already committed — that ordering is what makes this the
  // place the fabrication check actually happens.
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Before you name a single candidate: what does the direction actually translate to (stage band, domain, geo, any hard filter you must honor)? Did you search the web or work from knowledge, and why was that the right call here? Then go candidate by candidate — for each, WHERE it came from (a specific search result you read in this run, or your own knowledge), whether it's already on the watchlist, and any factual claim you're about to make in its reason and whether you actually read that claim or are reconstructing it. Drop the ones you can't ground; a claim you can't cite is a fabrication, not a candidate. Finish by saying where you cut the list off and why — a short on-target list is the right answer to a narrow direction, never a reason to pad.",
  },
  maxTurns: MAX_TURNS,
  system: SYSTEM_PROMPT,
  userContent: renderUserContent,
  readTools: [fetchUrlTool as AnyToolDef],
  serverTools: [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: MAX_WEB_SEARCH_USES,
    } as unknown as Anthropic.ToolUnion,
  ],
  outputSchema: COMMIT_CANDIDATES_SCHEMA,
  caption: (input) => `Looking for companies (target ${input.count ?? 10})…`,
  parse(out, input) {
    const existingNamesNormalized = new Set(
      input.watchlist.map((w) => w.name.toLowerCase()),
    );

    const candidates: FindCompaniesCandidate[] = (out.candidates ?? [])
      .filter(
        (c): c is { name: string; oneLineReason: string; url?: string } => {
          if (!c.name || !c.oneLineReason) return false;
          return !existingNamesNormalized.has(c.name.toLowerCase());
        },
      )
      .map((c) => ({
        name: c.name.trim(),
        oneLineReason: c.oneLineReason.trim(),
        url: c.url && c.url.trim().length > 0 ? c.url.trim() : undefined,
      }))
      // Dedupe by name in case the sub-agent emitted the same company twice.
      .filter(
        (c, i, arr) =>
          arr.findIndex(
            (x) => x.name.toLowerCase() === c.name.toLowerCase(),
          ) === i,
      );

    return { candidates, analysis: out.analysis?.trim() || null };
  },
};
