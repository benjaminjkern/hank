// Company basic-info hunter sub-agent (judgement class).
//
// Given a stub Company (just a name), find: a verified careers URL, the
// canonical brand name, and a short factual description. Tries Greenhouse /
// Lever / Ashby / Workable slug guesses, web_search, the company's own
// homepage, and — for enterprises on Workday, whose shard/site can't be
// slug-guessed — careers-page resolution via test_scrape. Escalates
// strategies until one works. A URL only counts as "working" if `test_scrape`
// returns ≥2 real jobs (single-job boards are usually template / "open
// application" entries).
//
// On success the sub-agent emits `report_basic_info({outcome: "found", ...})`
// and the caller commits sourceUrl + canonicalName + description + a
// short note under `companies/{slug}.md`. On exhaustion it emits
// `report_basic_info({outcome: "cannot_scrape", reason})` and the caller
// marks the company BLOCKED (blockReason=CANNOT_SCRAPE) — the stub stays so the
// user can later supply a URL by hand.
//
// Judgement-class rather than a front-loaded transform because the search space
// is wide (each name maps to many possible slugs / domains / search queries) and
// the strategies cascade — what to try next depends on what just failed.
//
// The hunter does NOT receive user preferences — it only needs to know about
// the company, so it can run in parallel with anything else without coupling
// to user-specific signal.

import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { fetchUrlTool } from "@/server/agent/tools/registry/fetchUrl";
import { probeAtsTool } from "@/server/agent/tools/registry/probeAts";
import { testScrapeTool } from "@/server/agent/tools/registry/testScrape";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

import type Anthropic from "@anthropic-ai/sdk";

// flash 5/0/0 — the URL hunt self-verifies via test_scrape, so flash's
// fabrication tendency gets caught in-loop.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 4096;
// High cap rather than a tight budget. The hunter's entire job is "don't give
// up early" — a too-tight cap would force premature CANNOT_SCRAPE. The
// forced-output-schema fallback on the last turn still guarantees we never come
// back without an outcome. If real-world hunts ever burn through this, the
// right response is to investigate (probably a bad slug-guessing loop), not
// to raise the cap further.
const MAX_TURNS = 20;

export type CompanyBasicInfoInput = {
  companyName: string;
  // Free-form text the caller forwards from the main agent
  // ("user mentioned them as a Series-B data-infra company they saw at
  // re:Invent"). Used for disambiguation only — the hunter shouldn't try to
  // match user preferences here.
  extraContext?: string;
  // A careers/ATS board URL the discovery step already saw for this company.
  // When present, the hunter test_scrapes it FIRST and — if it
  // produces real jobs for the right company — uses it without re-guessing a
  // slug. This is both the collision guard (discovery resolved the right
  // company already) and the slug-discovery shortcut (no probe/web_search
  // needed when the board is already known).
  candidateUrl?: string;
};

type BasicInfoFound = {
  outcome: "found";
  sourceUrl: string;
  canonicalName: string;
  shortDescription: string;
  longNotes: string | null;
  provider: string;
  jobCount: number;
};

type BasicInfoCannotScrape = {
  outcome: "cannot_scrape";
  reason: string;
  // The careers page the hunt got furthest with, even though nothing scrapeable
  // came out of it. NOT a working board — it's the starting point recon needs,
  // and without it a company on an unrecognized board is unreachable: it never
  // gets a sourceUrl, so no later scrape (and therefore no later recon) can
  // ever run against it.
  bestCandidateUrl: string | null;
  // What the hunt learned about the company regardless of the board. Carried so
  // that a recon success can commit a real name + blurb instead of leaving the
  // stub named whatever the user typed.
  canonicalName: string | null;
  shortDescription: string | null;
  longNotes: string | null;
};

// One real company the queried name could refer to. Each is a
// test_scrape-verified board for a DIFFERENT real company sharing the name —
// the hunter emits these instead of guessing when context doesn't disambiguate.
export type AmbiguousCompanyCandidate = {
  canonicalName: string;
  sourceUrl: string;
  shortDescription: string;
};

type BasicInfoAmbiguous = {
  outcome: "ambiguous";
  candidates: AmbiguousCompanyCandidate[];
};

export type CompanyBasicInfoOutput =
  BasicInfoFound | BasicInfoCannotScrape | BasicInfoAmbiguous;

const REPORT_BASIC_INFO_SCHEMA: SubAgentOutputSchema = {
  name: "report_basic_info",
  description:
    "Emit the basic-info hunter's final outcome. Set outcome='found' when you have a careers URL that test_scrape verified produces ≥2 real jobs (1 can be a dummy/template — verify with sampleTitles). Set outcome='ambiguous' when the queried name maps to ≥2 DIFFERENT real companies (each with a working board) and the provided context doesn't tell you which one the user meant — return the candidates so the user can pick, rather than guessing. Set outcome='cannot_scrape' only after you've exhausted every reasonable strategy: probe_ats, at least one web_search for the company's ATS, fetching their homepage to look for an ATS link, and running test_scrape on the company's careers page itself (that's what resolves enterprise Workday / iCIMS boards). Premature cannot_scrape is the most common failure mode here — keep trying.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["found", "cannot_scrape", "ambiguous"],
      },
      sourceUrl: {
        type: "string",
        description:
          "Required when outcome='found'. The careers URL that test_scrape returned ≥2 jobs for. Prefer the canonical ATS URL (jobs.lever.co/<slug>, boards.greenhouse.io/<slug>, jobs.ashbyhq.com/<slug>) over a bespoke /careers redirect.",
      },
      canonicalName: {
        type: "string",
        description:
          "Required when outcome='found', and worth filling on 'cannot_scrape' too if you worked out who they are. The company's actual brand name as you'd display it on a page (\"Cognition Labs\", not \"cognition-ai\"). Don't slug-derive — use what web_search shows you, or what the ATS board's header says.",
      },
      shortDescription: {
        type: "string",
        description:
          "Required when outcome='found'. One-line factual blurb for the company panel header: stage, sector, what they do. ≤120 chars. Example: \"Series B data-infra company; pipelines + observability for analytics teams\".",
      },
      longNotes: {
        type: "string",
        description:
          "STRONGLY ENCOURAGED when outcome='found' — fill it unless web_search genuinely surfaced nothing beyond the one-liner. A few sentences of narrative the shortDescription can't hold: funding stage + recent rounds, what the product actually does and who for, notable customers/scale, eng-culture or tech-stack signal, anything that helps judge fit later. **ALWAYS include where the company HIRES** — HQ + main office locations + remote policy (e.g. \"HQ NYC; offices SF + London; hires US-remote for engineering\"). This is the LOCATION EVIDENCE the downstream fit / location-mismatch checks rely on: without it they can't tell whether a company never hires where the user can work, and a location call becomes a guess off the few roles that happened to be posted. If a quick web_search shows offices in the user's area or a remote-friendly policy, say so explicitly. This is the company's memory note (companies/{slug}.md) — the shortlist/decider/drafter read it, and a company with no note is one they go in blind on. Don't pad with fluff, but most real companies warrant 2-4 sentences here; leaving it blank should be the exception, not the default.",
      },
      reason: {
        type: "string",
        description:
          "Required when outcome='cannot_scrape'. One sentence on what you tried and why nothing worked. Be specific — e.g. \"No matching greenhouse/lever/ashby/workable slug; web_search returned only third-party aggregators; homepage has no careers link.\" The user will see this if they ask why.",
      },
      bestCandidateUrl: {
        type: "string",
        description:
          "STRONGLY ENCOURAGED when outcome='cannot_scrape'. The careers/jobs page you got FURTHEST with — the one that looked most like it lists their openings, even though test_scrape couldn't read it. It does NOT have to work; a page that clearly shows roles but wouldn't scrape is exactly what's wanted. Omit only if you never found any plausible careers page at all. This is the single most useful thing you can leave behind on a give-up: it's the starting point for working out how to read an unusual board later, and without it there is nothing to come back to.",
      },
      candidates: {
        type: "array",
        description:
          "Required when outcome='ambiguous' (2-4 entries). Each is a DIFFERENT real company the queried name could mean, with a test_scrape-verified board. The user picks one. Plain English only — no slugs/enums/internal jargon in the labels; these render directly to the user.",
        items: {
          type: "object",
          properties: {
            canonicalName: {
              type: "string",
              description:
                'This candidate\'s brand name as the user would recognize it (e.g. "Runway" the AI-video company vs. "Runway" the FP&A platform). Make the labels distinguishable.',
            },
            sourceUrl: {
              type: "string",
              description:
                "This candidate's verified careers/ATS board URL (test_scrape returned ≥2 real jobs).",
            },
            shortDescription: {
              type: "string",
              description:
                'One-line factual blurb that makes clear WHICH company this is (≤120 chars). e.g. "AI video generation (gen-2/gen-3)" vs. "FP&A + financial planning SaaS". This is the disambiguator the user reads.',
            },
          },
          required: ["canonicalName", "sourceUrl", "shortDescription"],
        },
      },
    },
    required: ["outcome"],
  },
};

type BasicInfoFinalInput = {
  outcome?: string;
  sourceUrl?: string;
  bestCandidateUrl?: string;
  canonicalName?: string;
  shortDescription?: string;
  longNotes?: string;
  reason?: string;
  candidates?: Array<{
    canonicalName?: string;
    sourceUrl?: string;
    shortDescription?: string;
  }>;
};

export const companyBasicInfoSubAgent: SubAgentDef<
  CompanyBasicInfoInput,
  BasicInfoFinalInput,
  CompanyBasicInfoOutput
> = {
  name: "company_basic_info",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  // Aimed squarely at the failure the schema description already names as the
  // most common one here: giving up on the board too early. Having to write down
  // which strategies were actually TRIED — as opposed to which ones felt
  // exhausted — is what makes a premature `cannot_scrape` visible to the model
  // itself before it emits one.
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Before you emit an outcome, account for what you actually did. List the strategies you ran and what each returned: probe_ats, web_search for the company's ATS, fetching the homepage and looking for a careers/jobs link, test_scrape on the careers page itself. For 'found', name the URL and the test_scrape result that verified it (how many real jobs, and which sampleTitles convinced you they aren't dummies) — and separate what you VERIFIED from what you inferred, since the canonical name and description must come from something you read, not from the slug. For 'ambiguous', name the ≥2 distinct real companies and say why the provided context doesn't pick one. For 'cannot_scrape', go back through the list above: any strategy you have NOT tried yet means you are not done — try it instead of concluding.",
  },
  maxTurns: MAX_TURNS,
  system: buildSystemPrompt,
  userContent: buildInitialUserContent,
  readTools: [
    probeAtsTool as AnyToolDef,
    testScrapeTool as AnyToolDef,
    fetchUrlTool as AnyToolDef,
  ],
  serverTools: [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    } as unknown as Anthropic.ToolUnion,
  ],
  outputSchema: REPORT_BASIC_INFO_SCHEMA,
  caption: (input) => `hunting careers URL for "${input.companyName}"…`,
  usageNotes: (input, turn) => `turn=${turn} company=${input.companyName}`,
  // The hunter forwards its per-turn reasoning text and every
  // test_scrape/fetch_url/web_search call to the parent tool chip (via the
  // ctx trace), so the user can expand and watch the hunt unfold instead of
  // staring at a silent 20-turn loop.
  parse: validateOutput,
};

// Structurally-wrong emissions THROW — runSubAgent turns that into an ordinary
// {ok:false} result, so a half-filled `found` never reaches a caller.
function validateOutput(input: BasicInfoFinalInput): CompanyBasicInfoOutput {
  if (input.outcome === "found") {
    if (!input.sourceUrl || !input.canonicalName || !input.shortDescription) {
      throw new Error(
        "basic-info hunter emitted outcome=found but is missing sourceUrl, canonicalName, or shortDescription",
      );
    }
    return {
      outcome: "found",
      sourceUrl: input.sourceUrl,
      canonicalName: input.canonicalName,
      shortDescription: input.shortDescription,
      longNotes: input.longNotes?.trim() ? input.longNotes.trim() : null,
      // provider + jobCount are filled in by the caller after its
      // canonical real scrape; the hunter doesn't need to re-emit them.
      provider: "unknown",
      jobCount: 0,
    };
  }
  if (input.outcome === "ambiguous") {
    const candidates = (input.candidates ?? [])
      .filter(
        (c): c is AmbiguousCompanyCandidate =>
          !!c.canonicalName?.trim() &&
          !!c.sourceUrl?.trim() &&
          typeof c.shortDescription === "string",
      )
      .map((c) => ({
        canonicalName: c.canonicalName.trim(),
        sourceUrl: c.sourceUrl.trim(),
        shortDescription: c.shortDescription.trim(),
      }))
      // Dedupe on the board URL — two "candidates" pointing at the same board
      // aren't a real ambiguity.
      .filter(
        (c, i, arr) => arr.findIndex((x) => x.sourceUrl === c.sourceUrl) === i,
      );
    if (candidates.length < 2) {
      throw new Error(
        "basic-info hunter emitted outcome=ambiguous but provided fewer than 2 distinct, fully-specified candidates",
      );
    }
    return { outcome: "ambiguous", candidates };
  }
  if (input.outcome === "cannot_scrape") {
    return {
      outcome: "cannot_scrape",
      reason: input.reason ?? "(no reason given)",
      bestCandidateUrl: input.bestCandidateUrl?.trim() || null,
      canonicalName: input.canonicalName?.trim() || null,
      shortDescription: input.shortDescription?.trim() || null,
      longNotes: input.longNotes?.trim() || null,
    };
  }
  throw new Error(
    `basic-info hunter emitted invalid outcome: ${JSON.stringify(input.outcome)}`,
  );
}

function buildSystemPrompt(): string {
  return `You are the basic-info hunter for a chat-first job application tool. Your job: given a company name, find a careers URL that produces ≥2 real job postings, plus a short factual description of the company.

# Disambiguation — do this FIRST for short or generic names

**Trigger**: If the companyName is short (≤6 chars), a common English word ("Arbor", "Dust", "Glean", "Replit", "Linear"), or otherwise something that could collide with an unrelated company on the same ATS, do a **disambiguation web_search BEFORE trying ATS-slug guesses**. Query like \`"<Company Name>" company\` or \`"<Company Name>" founded\` and read the snippets. Identify what THIS company is (sector, stage, founder, product) so you can validate ATS hits against the right entity.

For example, "Arbor" can resolve to \`jobs.ashbyhq.com/arbor\` (real jobs — but a DIFFERENT Arbor company) when the company you want is at \`jobs.ashbyhq.com/findarbor\`; a 30-second web_search up front catches the collision.

When extraContext is provided, lean on it for disambiguation — the caller passes anything the user said ("Series B data-infra company", "I saw them at re:Invent") specifically so you can disambiguate without an extra search.

# Candidate URL — verify it FIRST when one is provided

If the input includes a **candidate board URL**, the discovery step already found a careers/ATS board it believes is this company's. **test_scrape it before anything else.** If it returns ≥2 real jobs AND the board header / companyName / sample titles match the company you were sent to find, report it as sourceUrl immediately — you're done, no probe_ats / web_search needed. This is the fast path AND a collision guard (discovery already resolved which company is meant). Only fall through to the strategy below if the candidate URL fails to scrape or clearly belongs to a different company.

# Strategy (in order — escalate when the previous step fails)

1. **Probe the slug-guessable ATSes deterministically — call \`probe_ats\` FIRST.** Pass the company name and, if you know it (from extraContext, a candidate URL, or a web_search), the website \`domain\`. It tries the obvious name-derived slugs AND domain-style ones (Ashby's \`qdrant.tech\`) across greenhouse / lever / ashby / teamtailor / gem in parallel — free, deterministic, no LLM, no web_search. This replaces guessing slugs by hand for the easy cases. If you still want to hand-test a slug \`probe_ats\` didn't generate (an odd abbreviation, "Cognition Labs" → \`cognition-labs\`), use **test_scrape** — also free for ATS URLs.
   **Validation gate (CRITICAL for short/generic names):** \`probe_ats\` and \`test_scrape\` only confirm a board produces jobs — NOT that it's the *right* company's board. When a hit returns jobs, check that the ATS board header / companyName / a sample job title matches the company you were sent to find. If the board header says "Arbor — sustainable forestry tooling" but your disambiguation showed the target Arbor is a fintech, that's a collision — move on. Reporting outcome=found on a collision is the failure mode this gate prevents. (Note: \`probe_ats\` can surface MULTIPLE boards for a generic name; if two of them are clearly different real companies and the context doesn't tell you which the user meant, that's the ambiguous case — see below.)

2. **web_search** for the company's ATS. Queries like:
   - \`"<Company Name>" careers greenhouse OR lever OR ashby OR workable\`
   - \`"<Company Name>" jobs site:greenhouse.io OR site:lever.co OR site:ashbyhq.com\`
   Read the snippets; pluck out ATS URLs and test_scrape them. **max 5 web_search uses per hunt.**

3. **Fetch the company's homepage** with fetch_url and scan the result for ATS links. Look for: \`href="boards.greenhouse.io/..."\`, \`href="jobs.lever.co/..."\`, \`href="jobs.ashbyhq.com/..."\`, or a "Careers" / "Jobs" / "We're hiring" anchor that leads to one. Follow the chain.

4. **Enterprise ATSes (Workday / iCIMS) — point \`test_scrape\` at the CAREERS PAGE, not a guessed slug.** Big/established companies (FAANG-adjacent, F500, enterprises) are disproportionately on Workday or iCIMS and rarely on greenhouse/lever/ashby, and neither can be slug-guessed: a Workday board lives at \`{tenant}.{shard}.myworkdayjobs.com/{site}\` where the shard is an unguessable data-center number (Expedia is \`expedia.wd108/search\`), and a modern iCIMS site is an Angular app on a per-company domain (\`careers.{company}.com\`) whose jobs API is at \`{origin}/api/jobs\`. So when steps 1-3 miss for a company that clearly has many openings — or whenever a web_search / fetch_url shows ANY hint of either (a \`myworkdayjobs.com\` link, "powered by Workday", an \`icims.com\` link, "powered by iCIMS", \`ats_code: icims\`) — call **test_scrape on the company's careers page**: its homepage, a "Life at {Company}" page, or \`careers.{company}.com\`. When the URL isn't itself a board, test_scrape reads the page, extracts the real board behind it, verifies it scrapes, and tells you the board URL. Report THAT URL as sourceUrl, not the page you passed in. (Not covered: the older standalone \`careers-{co}.icims.com/jobs/search\` boards, which have no JSON API — see the iCIMS note below.)

**test_scrape must return ≥2 real jobs**, with sample titles that look like real role titles (e.g. "Senior Backend Engineer", "Staff Product Designer") — not "Open Application" or "Don't see your role?" template entries. A single-job board is suspicious; one-real-one-template boards still count if the real one looks legitimate.

When you find the winner, emit **report_basic_info** with:
- outcome: "found"
- sourceUrl: the verified URL
- canonicalName: the company's actual brand name (from web_search or the ATS board's header — not slug-derived)
- shortDescription: a one-line factual blurb for the company panel (≤120 chars; e.g. "Series B data-infra company; pipelines + observability for analytics teams")
- longNotes (optional but strongly encouraged): 1-3 paragraphs of background that wouldn't fit in shortDescription — context the agent should remember next session. **Always include where the company HIRES (HQ + offices + remote policy)** — that's the location evidence later fit/location-mismatch calls depend on. Persisted as the seed of companies/{slug}.md.

# When the name is genuinely ambiguous — return candidates, don't guess

Sometimes a name maps to **two or more different real companies, each with a working board** (the classic case: "Runway" the AI-video company at one board vs. "Runway" an FP&A SaaS at another; two unrelated "LINER" companies). \`probe_ats\` can surface several at once. If — after using the candidate URL and any extraContext — you still can't tell which one the user meant, **do NOT pick the one with more jobs or guess.** Emit \`report_basic_info\` with:
- outcome: "ambiguous"
- candidates: 2-4 entries, each a different real company with its verified board (sourceUrl), a distinguishable canonicalName, and a shortDescription that makes clear WHICH company it is. The user picks one.

Only do this for a TRUE collision (different companies). If the context or candidate URL already tells you which company is meant, just report outcome="found" — don't punt an easy call to the user. And if only one real company matches and the others are template/empty boards, that's not ambiguity — report the real one.

# When to give up

**Don't give up early.** CANNOT_SCRAPE is the answer only after:
1. Ran \`probe_ats\` (with the domain if known) and it returned no usable board,
2. Ran at least one web_search for the ATS, AND
3. Fetched the homepage at least once looking for ATS links, AND
4. Ran **test_scrape on the company's careers page itself** (homepage / "Life at {Company}" / \`careers.{company}.com\`) — that's what resolves an enterprise Workday or iCIMS board, and it's the step most often skipped. Do this for any company big enough to plausibly be on one, and ALWAYS when you saw a Workday or iCIMS hint.

If all strategies fail, emit report_basic_info with outcome="cannot_scrape", a one-sentence reason that names what you tried, and — importantly — **bestCandidateUrl: the careers page you got furthest with**, even though it wouldn't scrape. A page that visibly lists their roles but that test_scrape couldn't read is exactly what to put there; it's what makes the board reachable later. Fill canonicalName / shortDescription too if you worked out who the company is. (Exception: the sub-brand-with-no-own-board case above is a deliberate cannot_scrape that names the parent — not a give-up.)

# iCIMS boards

**iCIMS specifically:** iCIMS careers pages show \`icims.com\` links or "powered by iCIMS". The modern iCIMS career-site product (branded \`careers.{company}.com\` Angular app) **IS supported** — run test_scrape on that careers URL (step 4 above), not cannot_scrape. Only fall back to cannot_scrape for the *older* standalone \`careers-{co}.icims.com/jobs/search\` boards that have no \`/api/jobs\` API (test_scrape reports "no board found" for those — they'd need a headless render we haven't built). Don't pad cannot_scrape just because a hunt failed for a company that simply has no public board.

# What you DON'T do

- Don't read user preferences or write any user-specific signal — that belongs in PRE_SCAN later.
- Don't write to memory or the database directly — your final tool is your only output.
- Don't make multiple final-tool calls; one outcome per run.
- Don't invent jobs that test_scrape didn't actually find — the caller re-scrapes after you commit, and any drift will be caught immediately.`;
}

function buildInitialUserContent(args: CompanyBasicInfoInput): string {
  const lines = [`# Company to hunt\nname: ${args.companyName}`];
  if (args.extraContext && args.extraContext.trim().length > 0) {
    lines.push(
      "",
      "# Context the user provided (for disambiguation only)",
      args.extraContext.trim(),
    );
  }
  if (args.candidateUrl && args.candidateUrl.trim().length > 0) {
    lines.push(
      "",
      "# Candidate board URL (verify this FIRST)",
      `${args.candidateUrl.trim()}`,
      "The discovery step believes this is the company's careers/ATS board. test_scrape it before anything else; if it returns ≥2 real jobs for the right company, report it and stop.",
    );
  }
  lines.push(
    "",
    args.candidateUrl && args.candidateUrl.trim().length > 0
      ? "Verify the candidate URL first. If it doesn't pan out, call probe_ats (pass the website domain if you know it), then escalate to web_search / fetch_url. When you have a verified URL (≥2 real jobs) that matches the right company, call report_basic_info."
      : "Start by calling probe_ats (pass the website domain if you know it). Escalate to web_search and fetch_url only if it comes back empty. When you have a verified URL (≥2 real jobs) that matches the right company, call report_basic_info.",
  );
  return lines.join("\n");
}
