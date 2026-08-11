// Scan-step pass 2: MATCH (transform sub-agent, user-dependent).
//
// Judges ONE role against ONE candidate and returns an ABSOLUTE verdict —
// "could this be on the shortlist?" — never a ranking. The shortlist rollup does
// the relative work later.
//
// SCOPE (deliberate): one role, one user. It does NOT look at other roles at the
// same company or at this user's past AUTOMATED decisions there — feeding a
// verdict back in as evidence lets one wrong close snowball into the next. The
// company-level signal it does get is descriptive, not judgemental: what the
// company does (Company.description) plus the user's own notes
// (companies/{slug}.md, and jobs/{slug}.md when this role has been discussed
// before), which is what the off-thesis-domain gate reads.
//
// Reads nothing and writes nothing: the caller (procedures/registry/scan/)
// loads the role + candidate context and persists the verdict through its own
// applyScanMatch.ts. Statuses are named as plain strings here and mapped to the
// Prisma enums at that boundary, so this file stays free of both the DB client
// and the schema.

import { attributePairs } from "@/server/entities/jobs/attributePairs";
import {
  roleAttrPairs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// flash 6/0/0 against rebuilt self-contained fixtures (2026-06-19) — the verdict
// is bounded by the summary + thesis it's handed.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 1024;

const SCAN_CLOSE_REASONS = [
  "NOT_A_MATCH",
  "LOCATION_MISMATCH",
  "OTHER",
] as const;
export type ScanCloseReason = (typeof SCAN_CLOSE_REASONS)[number];

const SCAN_MATCH_BUCKETS = ["STRONG", "POSSIBLE", "WEAK"] as const;
export type ScanMatchBucket = (typeof SCAN_MATCH_BUCKETS)[number];

// The role as the model sees it. `summary` arrives already chosen (the enriched
// summary, or the raw posting when enrichment hasn't run) — deliberately unlike
// shortlistJobs, which takes both and picks inside `userContent`. The choice
// isn't only prompt text here: an empty result means there's nothing to judge,
// which ends the pass at `not_enriched` before any call. And the summary may be
// one this run's enrich pass just produced, so it isn't on a row to read.
export type ScanJobRole = RoleAttrs & {
  title: string;
  companyName: string;
  summary: string;
  attributes?: unknown;
  enrichedAttributes?: unknown;
};

export type ScanJobInput = {
  role: ScanJobRole;
  profile: string;
  resume: string;
  // What the company actually DOES, in one line (Company.description) — the
  // signal the off-thesis-domain gate rests on, rather than guessing from name.
  companyDescription: string | null;
  // The company note and the role note, each with the path it came from, so the
  // prompt labels them the way the agent addresses them. The role note
  // (jobs/{slug}.md) is usually absent here — scan runs on freshly-scraped NEW
  // roles, so one exists only when this role has already been discussed.
  companyNote: string | null;
  companyNotePath: string | null;
  jobNote: string | null;
  jobNotePath: string | null;
};

export type ScanJobVerdict =
  | {
      decision: "match";
      bucket: ScanMatchBucket;
      score: number | null;
      reason: string;
    }
  | {
      decision: "skip";
      closeReason: ScanCloseReason;
      reason: string;
      summaryLabel?: string;
    };

// On failure the result's `status` carries the Anthropic status of an APIError
// (429/529 → the caller's fan-out aborts and resumes from the enrichment cache
// next pass).

const COMMIT_MATCH_SCHEMA: SubAgentOutputSchema = {
  name: "commit_match",
  description:
    "Emit the match verdict for this one role against this one candidate. `decision: 'match'` keeps it in play (with a coarse bucket); `decision: 'skip'` disqualifies it. Do NOT rank against other roles — that happens later. `reason` is shown to the user, so write plain English with no status names or jargon.",
  inputSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["match", "skip"],
        description:
          "MUST match the 'Conclusion:' line you wrote in `analysis`. match = plausible for this candidate, keep it for the shortlist. skip = disqualified (off-thesis role type, geo can't work for THIS role, hard-pass, >2 levels off seniority, off-thesis company domain).",
      },
      bucket: {
        type: "string",
        enum: SCAN_MATCH_BUCKETS as readonly string[] as string[],
        description:
          "Required when decision=match. STRONG = clear fit at the right level. POSSIBLE = plausible, worth surfacing. WEAK = survived (not a disqualifier) but a stretch. Don't overuse STRONG.",
      },
      score: {
        type: "number",
        description:
          "Optional 0-100 fit score for tie-breaking within a bucket. Coarse is fine.",
      },
      closeReason: {
        type: "string",
        enum: SCAN_CLOSE_REASONS as readonly string[] as string[],
        description:
          "Required when decision=skip. NOT_A_MATCH = role type/level/domain off-thesis. LOCATION_MISMATCH = geo can't work. OTHER = explain in reason.",
      },
      reason: {
        type: "string",
        description:
          "One short user-facing sentence — the FINAL verdict only, NOT your reasoning trail. Do all reconsidering in `analysis`; this field never contains 'let me reconsider' / 'wait' / 'actually' / 'passes geo'. For a match: why it fits ('IC backend infra at your level, NYC/remote'). For a skip: the disqualifier ('Sales role — you target engineering' / 'SF-onsite, off your remote thesis'). Address the user as 'you' / 'your' — NEVER by name and never as 'the user' / 'the candidate' (this string is shown to the user; 'outside the user's scope' / 'the user wants X' both read as machine text). For a skip, lead with a noun phrase naming the role ('Sales role', 'Senior-level position'), not a copular sentence ('Role type is sales'). Natural English only — no enum names, no 'SCANNED'/'CLOSED', no tool jargon.",
      },
      summaryLabel: {
        type: "string",
        description:
          "ON A SKIP only: 2-4 words completing 'N of them were ___' for the company-level summary shown when a walkthrough surfaces nothing — e.g. 'sales roles', 'product roles', 'senior-level positions', 'in Europe', 'in defense'. Bare category, plural, lowercase, NO contrast (that's in `reason`). Skips are TALLIED by this label and every distinct group is reported, so label by the ACTUAL disqualifier for THIS role — a role that's the right job in the wrong city is 'in Europe', never 'sales roles'. Omit on a match.",
      },
    },
    required: ["decision", "reason"],
  },
};

type CommitMatchInput = {
  decision?: string;
  bucket?: string;
  score?: number;
  closeReason?: string;
  reason?: string;
  summaryLabel?: string;
};

export const scanJobSubAgent: SubAgentDef<
  ScanJobInput,
  CommitMatchInput,
  ScanJobVerdict
> = {
  name: "scan_job",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Walk the gates in order and reach a conclusion: (1) role type / domain / seniority / comp vs thesis; (2) GEO — first state the candidate's workable region + metros, then check EVERY location the role lists and whether ANY ONE is workable (a workable/relocation metro passes even on-site; a multi-city role passes if ANY listed city is workable), then apply the on-site/hybrid hard-gate ONLY if NO listed location works. End with one line: 'Conclusion: match' or 'Conclusion: skip (<reason>)'.",
  },
  system: buildSystemPrompt,
  userContent: buildUserContent,
  outputSchema: COMMIT_MATCH_SCHEMA,
  caption: (input) => `Checking "${input.role.title}" against your thesis…`,
  parse: decodeVerdict,
};

// Decode the raw emission into the verdict union. Everything here is about
// tolerating a sloppy model — an unrecognized closeReason falls back to
// NOT_A_MATCH, an unrecognized bucket to POSSIBLE, a missing reason to a
// placeholder — so a bad draw degrades instead of throwing.
function decodeVerdict(i: CommitMatchInput): ScanJobVerdict {
  const reason = (i.reason ?? "").trim() || "(no reason given)";

  if (i.decision === "skip") {
    const closeReason = (SCAN_CLOSE_REASONS as readonly string[]).includes(
      i.closeReason ?? "",
    )
      ? (i.closeReason as ScanCloseReason)
      : "NOT_A_MATCH";
    const summaryLabel = i.summaryLabel?.trim() || undefined;
    return { decision: "skip", closeReason, reason, summaryLabel };
  }

  const bucket = (SCAN_MATCH_BUCKETS as readonly string[]).includes(
    i.bucket ?? "",
  )
    ? (i.bucket as ScanMatchBucket)
    : "POSSIBLE";
  const score =
    typeof i.score === "number" && Number.isFinite(i.score)
      ? Math.max(0, Math.min(100, Math.round(i.score)))
      : null;
  return { decision: "match", bucket, score, reason };
}

function buildUserContent(input: ScanJobInput): string {
  const { role } = input;
  // Both attribute bags: this pass reads the compressed summary, not the body,
  // so the enrich pass's extracted scalars still carry the structured
  // `remote=onsite|hybrid` signal the cleaned column can't always convey —
  // surfacing it is what lets the geo gate fire on a confirmed on-site role even
  // when the location string reads like a bare city.
  const meta = [
    ...roleAttrPairs(role),
    ...attributePairs(role.attributes),
    ...attributePairs(role.enrichedAttributes),
  ];

  return [
    `# Role\n## ${role.title} @ ${role.companyName}`,
    meta.length ? `(${meta.join(", ")})` : "",
    "",
    "## Role summary",
    role.summary,
    input.jobNote && input.jobNote.trim().length > 0
      ? `\n## Notes on this role (${input.jobNotePath ?? "role note"})\n${input.jobNote.trim()}`
      : "",
    "",
    "# Candidate profile (profile.md)",
    input.profile.trim() || "(no profile.md yet)",
    "",
    "# The candidate's background",
    input.resume,
    input.companyDescription && input.companyDescription.trim().length > 0
      ? `\n# What ${role.companyName} does\n${input.companyDescription.trim()}`
      : "",
    input.companyNote && input.companyNote.trim().length > 0
      ? `\n# Notes on this company (${input.companyNotePath ?? "company note"})\n${input.companyNote.trim()}`
      : "",
    "\nCall commit_match with your verdict.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSystemPrompt(): string {
  return `You decide whether ONE role is a plausible match for ONE candidate. You are given a summary of the role (already compressed, lossless), the candidate's thesis and resume, and — when they exist — a one-line description of what the company does plus the user's own notes on the company and on this role. Return your verdict via commit_match.

You make an ABSOLUTE per-role call — "could this be on the shortlist?" — NOT a ranking. A later step ranks the matches against each other; don't try to do that here, and don't skip a genuine match just because you suspect a better one exists elsewhere.

# Keep the reasoning trail out of \`reason\`
\`reason\` is the user-facing verdict ONLY — never put your "let me reconsider…" trail in it. All of that belongs in \`analysis\` (see the field description on commit_match).

# Gate FIRST, then bucket — a disqualifier is never a score deduction
The skip conditions below are HARD GATES. Evaluate them BEFORE you think about a bucket. If any one holds, the verdict is \`skip\` — **no matter how strong the role-type fit is.** A perfect-on-paper backend role in a city the candidate can't work is a \`skip\`, not a STRONG-knocked-down-to-POSSIBLE. Do NOT lower a bucket to "absorb" a disqualifier: there is no POSSIBLE/WEAK match that fails a gate — it's a skip. The buckets (STRONG/POSSIBLE/WEAK) only rank roles that have ALREADY cleared every gate. If you catch yourself writing a reason like "great fit, but the location/comp is off, so POSSIBLE" — stop: that "but" is a gate failure, so the answer is \`skip\` with the matching reason.

# Decide "skip" when ANY of these hold (hard gates)
- **Role type / domain off-thesis**: the candidate targets engineering and this is sales / CS / support / pure PM (note: Engineering Manager IS in scope for eng-targeting users; Product Manager is not). closeReason=NOT_A_MATCH.
- **Off-thesis company domain**: the company's whole business is something the candidate's thesis rules out (defense/weapons, hardware/automotive, gambling, etc. — read the thesis against "What <company> does" and the company note). An on-thesis title never rescues an avoided-domain company. closeReason=NOT_A_MATCH. Judge the domain only from what you were actually given: if there's no company description and the note says nothing about the business, you don't know the domain — don't infer it from the company's name and don't skip on it.
- **Geo can't work for THIS role** (see the geo section below). closeReason=LOCATION_MISMATCH.
- **Comp clearly below an explicit floor**: when the posting STATES a compensation that's clearly under a hard floor the candidate named in profile.md (convert currencies before comparing), that's a skip — not a demoted bucket. closeReason=NOT_A_MATCH. (Only when comp is BOTH stated AND the floor is explicit; never skip on comp the posting doesn't state.)
- **Seniority >2 levels off**: e.g. a Director/VP/Head-of role for a mid-level IC, or a junior role for a staff-level candidate (unless memory says lateral/stretch is OK). closeReason=NOT_A_MATCH.
- **Hard pass from memory**: profile.md names this role type/industry as an explicit avoid. closeReason=NOT_A_MATCH.

# Geo gate — judge THIS role's own stated location against the candidate's stated geo
Decide geo from the role's OWN \`location\` field + the \`remote=…\` scalar in the attribute bags, read against the candidate's stated geo preferences in profile.md. Nothing else. You have NO information about where this company hires in general — do not assume a company-wide location policy, and do not invent one.

**First establish the candidate's WORKABLE REGION.** From their thesis, work out (a) the metros they live in / target / will relocate to, and (b) the COUNTRY/REGION they can work remotely from. Infer the region conservatively: a candidate based in a US metro, targeting a US metro, is US work-authorized — for them "fully remote" means remote **within the US**, NOT remote from another country. Only treat a foreign region as workable if the thesis explicitly says so (dual citizenship, "open to EU roles", etc.). A candidate whose thesis is "NYC or fully remote, relocating to NYC" has workable region = **the US** (NYC metro + US-remote).

**Check PASSES first — a workable location beats the on-site/hybrid hard-gate below.** Look at EVERY location the role lists; if ANY ONE of them is workable for the candidate, the role passes geo. Only when NO listed location works do you reach the skip rules.

**What PASSES the geo gate (never a LOCATION_MISMATCH):**
- **A workable metro — even on-site or hybrid.** The candidate's current metro, target metro, or any city they'll relocate to. If the role is in that metro, it passes **regardless of arrangement** — "New York • Hybrid", "NYC Office • On-site", "New York, NY (on-site, 3 days/week)" ALL PASS for a candidate relocating to NYC. A workable metro is where they WANT to be; on-site/hybrid THERE is the goal, not a disqualifier. The hybrid/on-site hard-gate below applies ONLY to cities that are NOT workable. **"<Metro>-based" in a thesis MEANS on-site in that metro is workable** — a candidate whose thesis says "NYC-based or fully remote" and who is relocating to NYC WANTS on-site NYC; do NOT read "or fully remote" as "remote everywhere including NYC" and then reject on-site NYC as "not remote". On-site in the candidate's own target metro is never a LOCATION_MISMATCH.
- **A multi-location role where ANY option is workable.** If the role lists several places (e.g. "Bellevue, WA; Menlo Park, CA; or New York, NY") and at least one is a workable metro or in-region remote, it PASSES — the candidate simply picks that option. Do not skip a role because SOME of its locations don't work; skip only when NONE do. **This holds even when every option is on-site.** Worked example — "San Francisco • New York City • On-site" for a candidate relocating to NYC → **MATCH**: NYC is a listed option AND a workable target metro, so the candidate picks NYC; the SF option is irrelevant. The presence of a ruled-out on-site city (SF) alongside a workable one (NYC) does NOT trigger the hard-gate — the hard-gate fires only when NO listed location is workable. Do not let a ruled-out city in the list, or the word "on-site", pull you to skip when a workable metro is right there in the same list.
- **In-region remote.** A \`remote=remote\` scalar or a "Remote"/"Remote (US)"/"US-Remote" location the candidate can work remotely from **their own region** passes — never override an explicit in-region remote signal.

**What SKIPS (LOCATION_MISMATCH):**
- **Out-of-region — the most common miss.** A role that is on-site OR hybrid in a country/metro OUTSIDE the candidate's workable region (London, Paris, Berlin, Dublin, Bangalore, Toronto, Singapore, … for a US-only candidate), OR remote-only in a region the candidate can't work (\`remote\` but "EMEA remote" / "remote anywhere in India" / "remote within Europe" / a foreign-currency-only pay band like "UK pay band" / "€/£ base") → **skip, LOCATION_MISMATCH**, no matter how strong the role. Foreign remote is NOT the candidate's remote: a US-only candidate cannot take a UK/EU/India/Canada-remote role. A "#LI-Remote" tag on a London-based posting means remote *in the UK*, not the US — still a skip. Do NOT let the word "remote" auto-pass a foreign role.
- **Ruled-out domestic city on-site/hybrid** — the role is on-site OR hybrid, pinned to a specific in-country city that is neither workable nor a relocation target. "Hybrid" does not rescue an otherwise-ruled-out city (it still requires being there most of the week); only in-region remote or a workable metro does.

**Your DECISION must match your geo REASONING.** If your reasoning concludes the location doesn't work — "London on-site doesn't work for you", "neither is NYC/remote", "need to check if you can work remotely from NYC", "this is a skip on geo" — then the decision IS \`skip\` (LOCATION_MISMATCH). Do NOT narrate a geo mismatch and then emit \`match\` anyway. A geo doubt you can't resolve in the candidate's favor is a skip, not a POSSIBLE.

**A ruled-out on-site OR HYBRID location is a HARD gate — it beats a perfect role.** If the role's stated arrangement is on-site OR hybrid at a city that is neither workable nor a relocation target, the verdict is \`skip\` (LOCATION_MISMATCH) — **even if the role is a bullseye on domain, level, and stack.** There is NO bucket for "perfect role I physically can't do": do not return STRONG/POSSIBLE/WEAK to "reward" the fit. Two examples, both skips:
- "San Francisco • On-site" for a "NYC or fully remote only" candidate → LOCATION_MISMATCH skip, not a STRONG match.
- **"San Francisco • Hybrid" (or "Seattle • Hybrid", "Foster City, CA • Hybrid", "Toronto • Hybrid", a multi-city hybrid with no NYC option) for that same candidate → ALSO a LOCATION_MISMATCH skip.** Hybrid is NOT remote: it requires being physically in that office multiple days a week, so a hybrid role in a ruled-out city is just as unworkable as on-site. Only *fully remote*, or the candidate's own workable/relocation city, rescues geo — "hybrid", "flexible", "tech-flexible", and "in-office 3 days" at a non-workable city do NOT. The stronger the role reads, the more tempting this mistake — resist it.

**Company-level location guidance is NOT a role-level pass.** A thesis line like "don't close the COMPANY for location — it may post NYC/remote roles later" is about keeping the COMPANY on the watchlist; it does NOT turn an individual on-site-elsewhere ROLE into a match. This specific on-site-elsewhere role is still a job-level LOCATION_MISMATCH skip. (Whether the company stays on the list is decided elsewhere, not by you.)

**When in doubt, do NOT skip on location.** If the role's stated arrangement is genuinely ambiguous (a BARE city with no remote/on-site/hybrid signal at all), keep it — that's a match, the user makes the final call at the shortlist, and a wrong skip is invisible and unrecoverable. This keep-when-ambiguous rule is ONLY for a bare city with no arrangement; it does NOT apply once the role POSITIVELY states on-site/hybrid at a ruled-out city (that's the hard gate above). NEVER cite a location reason you can't ground in this role's own stated location text.

# The notes sections are the user's own words — weigh them as first-hand evidence
"What <company> does" is a factual one-liner about the business; the notes sections ("Notes on this role", "Notes on this company") are what the user themselves has said about this company or this exact role in past sessions. When a note speaks to this call — they've already ruled this company out, they specifically want this team, they said the level is fine — it outranks anything you'd infer from the posting. Two limits: a note that says nothing about fit changes nothing (don't reach for one to justify a verdict), and none of this is a record of PAST AUTOMATED VERDICTS — you have no skip history here, so never write "prior skips confirm…" or reason from how other roles at this company were judged.

# Otherwise "match" — pick a bucket
- **STRONG**: clear fit — right role type, at or one step up from the candidate's level, location works. Don't be stingy, but don't hand out STRONG to stretches.
- **POSSIBLE**: plausible and worth surfacing; some dimension is a little off or unstated.
- **WEAK**: survived (not a disqualifier) but a real stretch (level, comp unstated, adjacent function). Surfaced but rarely pre-checked later.

When the candidate's resume shows them CURRENTLY doing this role's function at this level, that's a STRONG — their stated preference to move elsewhere is a tilt, not a veto.

# reason
One short sentence, user-facing, plain English. No enum names, no "SCANNED"/"CLOSED", no tool/jargon. It's shown next to the role.`;
}
