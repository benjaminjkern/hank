// PRE_SCAN job-batch sub-agent (judgement class).
//
// Answers exactly one question, per job: is this an OBVIOUS no against the
// candidate's thesis, judging metadata only (title / location / department /
// comp / employmentType — never bodies)? Every job in the list gets a verdict;
// the caller maps them back to jobIds by position.
//
// It is handed a plain list of jobs and told nothing about chunking. The
// procedure (procedures/registry/preScan/) splits the board, runs this on each
// slice in parallel, concatenates the verdicts, and persists the closes — but
// none of that is visible from in here, so a slice's decisions never depend on
// where in the board it happened to fall.
//
// It also decides NOTHING about the company. Whether the company lands READY /
// CAUGHT_UP is the CALLER's call (add-time vs rescrape vs mid-walkthrough want
// different answers), and pre-scan cannot close a company at all: a
// metadata-only pass is the weakest evidence in the system, so an off-thesis
// DOMAIN shows up as every job skipping `not_a_match` and nothing more.
//
// Reads nothing from the DB — the caller front-loads profile.md / resume summary
// and what it knows about the company (its one-line description + the user's
// companies/{slug}.md note) and hands them in. That's what makes a fixture
// self-contained: the input IS the context, so there's no live-memory bypass to
// configure.

import { JobCloseReason } from "@/generated/prisma/client";
import { attributePairs } from "@/server/entities/jobs/attributePairs";
import {
  roleAttrPairs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { LlmModel } from "@/server/platform/llm/models";
import { SUB_AGENT_READ_TOOLS } from "@/server/subagents/lib/readTools";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

import type Anthropic from "@anthropic-ai/sdk";

// The cheap tier: metadata-only bucketing (title/loc/comp) doesn't need
// top-tier judgement, and output streaming is the bottleneck for big boards.
// The scan step reads full bodies downstream, so pre-scan is purely the
// metadata obvious-no filter. flash 6/0/0 against rebuilt self-contained
// fixtures (2026-06-19).
const MODEL: LlmModel = "deepseek-v4-flash";
// Sized for the widest emission this makes: a per-job {rationale, verdict} for a
// full CHUNK_SIZE batch, on top of the analysis scratchpad. Output tokens are
// pay-per-emit so the headroom costs nothing on small runs, and running out
// truncates the payload rather than degrading it — runSubAgent catches that as
// stop_reason=max_tokens, but headroom is the structural fix.
const MAX_TOKENS = 8192;
// The output schema is forced from turn 1 (`forceOutputFromTurn: 1`) — the
// front-loaded context is sufficient for metadata bucketing, and without it a
// model can waste turn 1 writing prose instead of emitting (and on chunked runs,
// pay the prefix cache_create twice). MAX_TURNS is a defensive ceiling that
// shouldn't fire.
const MAX_TURNS = 4;

// -- the skip vocabulary, in ONE place ---------------------------------------
//
// Adding a skip reason is one entry here. Everything downstream derives from it:
// the verdict union + the schema's `enum`, the prompt's verdict-value bullets,
// the closing instruction, and the verdict → JobCloseReason mapping the merge step
// applies.
//
// `guidance` is prompt prose and can be as long as the reason needs; `summary`
// is the one-line gloss the schema's enum description carries; `example` is a
// model-facing sample of the rationale that reason should produce.
type PreScanSkipReason = {
  verdict: `skip:${string}`;
  closeReason: JobCloseReason;
  summary: string;
  guidance: string;
  example: string;
};

const PRE_SCAN_SKIP_REASONS = [
  {
    verdict: "skip:not_a_match",
    closeReason: JobCloseReason.NOT_A_MATCH,
    summary: "role-type or the company's whole domain is clearly off-thesis",
    guidance:
      "title or role-type is clearly off-thesis (user wants backend engineering; this is enterprise sales), OR the company's whole DOMAIN is a thesis avoid, OR profile.md names this role type as an allergy.",
    example: "Product role — you're targeting backend engineering.",
  },
  {
    verdict: "skip:location_mismatch",
    closeReason: JobCloseReason.LOCATION_MISMATCH,
    summary:
      "RARE — metadata pins the role to a location the user named as a hard no",
    guidance:
      'RARE. Use ONLY when the metadata explicitly pins the role to a location the user named as a HARD, no-exceptions skip (e.g. "Los Angeles, On-site" when the user wrote "hard no on LA"). A bare city ("San Francisco"), a "City • Hybrid" / "On-site" tag, and "Remote" are all KEPT — pre-scan defers the geo call to the scan body-read. NEVER skip a city / hybrid / remote role just because the thesis says "hard no on non-NYC"; that\'s the scan step\'s call. (Skipping a city/hybrid engineering role here is a common over-skip — don\'t.) See **Location** below.',
    example: "Los Angeles on-site — the one metro you ruled out.",
  },
  {
    verdict: "skip:other",
    closeReason: JobCloseReason.OTHER,
    summary: "sparingly — anything the reasons above don't cover",
    guidance:
      "sparingly — a real disqualifier none of the reasons above covers. The rationale has to carry the whole explanation on its own.",
    example: "Six-month contract role — you're looking for full-time.",
  },
] as const satisfies readonly PreScanSkipReason[];

export type PreScanVerdict =
  "keep" | (typeof PRE_SCAN_SKIP_REASONS)[number]["verdict"];

const PRE_SCAN_VERDICT_VALUES: readonly PreScanVerdict[] = [
  "keep",
  ...PRE_SCAN_SKIP_REASONS.map((r) => r.verdict),
];

// The merge step's verdict → JobCloseReason lookup. Lives here so the table stays
// the only place that knows the vocabulary; `keep` (and anything malformed)
// returns undefined, which the merge reads as "this job survives".
export function preScanCloseReason(
  verdict: string | undefined,
): JobCloseReason | undefined {
  return PRE_SCAN_SKIP_REASONS.find((r) => r.verdict === verdict)?.closeReason;
}

// The metadata slice the model buckets from. No bodies, and no jobId — the list
// is presented 1..N and the verdict's POSITION carries the identity, so the
// model can't copy back (or invent) an identifier.
export type PreScanLeanJob = RoleAttrs & {
  title: string;
  attributes?: unknown;
  // Present only for a job some earlier scan already enriched (enrichment is
  // global, so another user's pass fills it in). Null on the common
  // freshly-scraped path — but when it IS there it's the only structured
  // `remote=onsite|hybrid` this body-less pass can see, and the geo gate is
  // exactly what it's for.
  enrichedAttributes?: unknown;
};

// Everything the prompt needs, front-loaded by the caller.
export type PreScanJobBatchInput = {
  companyName: string;
  // What the company actually DOES (Company.description) and whatever the user
  // has said about it (companies/{slug}.md). Both optional — a company added
  // seconds ago has neither. They're what the domain skip reads: without them
  // the only domain signal is the company's NAME, which is a guess.
  companyDescription?: string | null;
  companyNote?: string | null;
  companyNotePath?: string | null;
  profile: string;
  resume: string;
  extraContext?: string;
  jobs: PreScanLeanJob[];
  // Run closed-book: a caller that front-loads the whole pool + thesis (a
  // supplied context) drops the read tools so the model can't reach past what it
  // was shown into live memory.
  closedBook?: boolean;
};

// One decision + the sentence that justifies it, together. Both fields are
// optional because this is raw model output — the merge treats a missing or
// unrecognized `verdict` as a survivor rather than trusting the shape.
export type PreScanJobVerdict = {
  rationale?: string;
  verdict?: string;
  summaryLabel?: string;
};

export type PreScanJobBatchOutput = {
  verdicts?: PreScanJobVerdict[];
};

// -- output schema -----------------------------------------------------------
//
// Verdict-per-item shape: the job list is numbered 1..N and the model
// returns a `verdicts` array of length N whose i-th entry decides job i. A
// "list of jobIds to skip" lets a model silently drop tail items from a long
// enumeration; forced one-verdict-per-slot makes an omission visible by
// construction.
//
// Each entry is `{ rationale, verdict }` — rationale FIRST, per the schema-order
// rule (docs/sub-agents.md → "Reasoning field FIRST"). Per-JOB rather than one
// shared sentence per reason bucket: a bucket-level rationale gives every job in
// it the same closeNote, so a NOT_A_MATCH bucket holding a sales role, a PM
// role, and a defense-domain role tells the user all three were skipped for
// whichever one the model happened to describe.

const SKIP_SUMMARIES = PRE_SCAN_SKIP_REASONS.map(
  (r) => `\`${r.verdict}\` = ${r.summary}`,
).join("; ");

const COMMIT_PRESCAN_SCHEMA: SubAgentOutputSchema = {
  name: "commit_prescan",
  description: `Emit one { rationale, verdict } per numbered job in the chunk (1..N from the list above), in order. \`verdicts\` MUST have exactly N entries — one per job. Use \`keep\` for survivors; for a skip, pick the reason that fits (${SKIP_SUMMARIES}) and write the rationale the user will read next to that role.`,
  inputSchema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        description:
          "One entry per job in the chunk, in the numbered order shown — job 1 → verdicts[0], job 2 → verdicts[1], and so on. Length MUST equal the chunk's job count; there is no 'leave blank' option.",
        items: {
          type: "object",
          properties: {
            rationale: {
              type: "string",
              description: `Write this FIRST, before \`verdict\` — the verdict must follow from it. ON A SKIP this is shown to the user next to the closed role, so FORMAT MATTERS: lead with a short NOUN PHRASE naming the role ('Product role', 'Enterprise sales role', 'Los Angeles on-site role'), NOT a sentence ('Role type is sales' renders as broken text), then the contrast, addressing the user as 'you' / 'your' — NEVER by name and never as 'the user' / 'the candidate' ('outside the user's scope' and 'the user wants backend' both leak through wrong; say 'outside what you're targeting' / 'you want backend'). 3-12 words. Examples: ${PRE_SCAN_SKIP_REASONS.map((r) => `'${r.example}'`).join(" / ")}. ON A KEEP nobody reads it — one terse internal phrase is enough ('Backend IC, on-thesis' / 'Ambiguous title, needs body-read').`,
            },
            verdict: {
              type: "string",
              enum: PRE_SCAN_VERDICT_VALUES as readonly string[] as string[],
              description: `Set AFTER \`rationale\`, matching it. \`keep\` = survivor (goes to shortlist for a full-description read); ${SKIP_SUMMARIES}.`,
            },
            summaryLabel: {
              type: "string",
              description:
                "ON A SKIP only: 2-4 words completing 'N of them were ___' for the company-level summary shown when a walkthrough surfaces nothing — e.g. 'sales roles', 'product roles', 'senior-level positions', 'in Europe', 'in defense'. Bare category, plural, lowercase, NO contrast (that lives in `rationale`). Skips are TALLIED by this label and every distinct group is reported, so label by the ACTUAL disqualifier for THIS role — a role that's the right job in the wrong city is 'in Europe', never 'sales roles'. Omit on a keep.",
            },
          },
          required: ["rationale", "verdict"],
        },
      },
    },
    required: ["verdicts"],
  },
};

export const preScanJobBatchSubAgent: SubAgentDef<
  PreScanJobBatchInput,
  PreScanJobBatchOutput
> = {
  name: "pre_scan_job_batch",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Go job by job in the numbered order (one short line each) and end each line with 'keep' or 'skip:<reason>'. Per job, apply THIS pass's narrow gates only (you are NOT reading bodies): (1) role-type — clear off-thesis title (sales/marketing/recruiting/pure-PM for an engineer) → skip:not_a_match; eng-adjacent/ambiguous title → keep for body-read; (2) domain — company's whole business is a thesis avoid (defense/hardware/automotive when ruled out) → skip:not_a_match; (3) profile.md allergy named → skip:not_a_match; (4) LOCATION — DEFER by default: a bare city, 'City • Hybrid', 'On-site', and 'Remote' are all KEEP (the scan body-read makes the geo call); skip:location_mismatch ONLY when the metadata pins the role to a location the user named as a HARD no-exceptions skip. When unsure, KEEP. A verdict that contradicts its own analysis line — concluding 'keep, defer geo' and then emitting skip:location_mismatch — is the specific failure to avoid.",
  },
  maxTurns: MAX_TURNS,
  forceOutputFromTurn: 1,
  system: buildSystemPrompt,
  userContent: buildUserContent,
  readTools: (input) => (input.closedBook ? [] : SUB_AGENT_READ_TOOLS),
  outputSchema: COMMIT_PRESCAN_SCHEMA,
  usageNotes: (input, turn) =>
    `turn=${turn} company=${input.companyName} jobs=${input.jobs.length}`,
};

// The stable thesis/resume prefix is cached via ephemeral cache_control so
// parallel chunks read it instead of paying the input tokens each time; the job
// list goes in a separate, uncached tail block (it differs per call, so caching
// it would burn cache_create on a payload never re-read).
function buildUserContent(
  input: PreScanJobBatchInput,
): Anthropic.ContentBlockParam[] {
  return [
    {
      type: "text",
      text: buildStablePrefix(input),
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: buildJobList(input) },
  ];
}

function buildStablePrefix(input: PreScanJobBatchInput): string {
  const sections: string[] = [`# Company: ${input.companyName}`];
  if (input.companyDescription && input.companyDescription.trim().length > 0) {
    sections.push(
      "",
      `## What ${input.companyName} does`,
      input.companyDescription.trim(),
    );
  }
  if (input.companyNote && input.companyNote.trim().length > 0) {
    sections.push(
      "",
      `## Notes on this company (${input.companyNotePath ?? "company note"})`,
      input.companyNote.trim(),
    );
  }
  sections.push(
    "",
    "# Candidate profile (profile.md)",
    input.profile.trim(),
    "",
    "# The candidate's background",
    input.resume,
  );
  if (input.extraContext && input.extraContext.trim().length > 0) {
    sections.push(
      "",
      "# Additional context (from this session)",
      input.extraContext.trim(),
    );
  }
  return sections.join("\n");
}

function buildJobList(input: PreScanJobBatchInput): string {
  const leanList = input.jobs
    .map((j, idx) => {
      const meta = [
        ...roleAttrPairs(j),
        ...attributePairs(j.attributes),
        ...attributePairs(j.enrichedAttributes),
      ];
      return `${idx + 1}. ${j.title}${meta.length ? ` (${meta.join(", ")})` : ""}`;
    })
    .join("\n");

  return [
    `# Jobs (${input.jobs.length} job${input.jobs.length === 1 ? "" : "s"})`,
    leanList,
    "",
    `Call commit_prescan with a verdicts array of exactly ${input.jobs.length} entries (one { rationale, verdict } per numbered job, in order).`,
  ].join("\n");
}

function buildSystemPrompt(): string {
  return `You are filtering a numbered list of open jobs at one company against a single candidate's search thesis. Return your decisions via the commit_prescan tool.

**Output shape**: \`verdicts\` is an array with exactly one \`{ rationale, verdict }\` entry per numbered job, in order. Job 1 → verdicts[0], Job 2 → verdicts[1], etc. Every job gets an entry — there is no "leave blank" option. This is the entire point of the schema: forced one-per-position prevents the dropped-tail bug where a skip-list version of this pass would silently omit jobs at the bottom of a long chunk.

Within each entry, write the **\`rationale\` first and the \`verdict\` after it**, matching. On a skip that rationale is what the user reads next to the closed role, so write it for them: lead with a noun phrase naming the role, then the contrast, addressing them as "you" ("Enterprise sales role — you're targeting backend engineering."). 3-12 words. On a keep nobody reads it, so a terse internal phrase is fine ("Backend IC, on-thesis").

**Your output is per-job verdicts and nothing more.** You are not judging the company — no company status, no "close this company", no verdict on whether the list as a whole is worth keeping. Even when every single job skips, all you say is that each job skipped and why. What that means for the company is decided elsewhere by code that can see things you can't (the rest of the board, what the user has already done here, whether this is a first look or a re-check).

Verdict values:
- **keep** — survives PRE_SCAN, will get its full description read at the shortlist stage.
${PRE_SCAN_SKIP_REASONS.map((r) => `- **${r.verdict}** — ${r.guidance}`).join("\n")}

**Scope**: title + location + compensation + employmentType only. You are NOT reading job bodies. The scan step (which reads each survivor's full description) and the shortlist cover the next layers. Borderline matches stay \`keep\` — don't trim eagerly.

**When unsure, KEEP. Under-skipping is the safe error; over-skipping is not.** A kept-but-marginal role costs almost nothing — the scan step reads its body and filters it then. A wrongly-skipped role is gone with no recovery. So whenever a skip isn't clearly justified by the metadata in front of you, keep the role and let the body-read decide. This applies hardest to **location** (defer ALL city / hybrid / remote calls to the scan body-read). The only skips that should feel certain: clear role-type misses (sales / marketing / recruiting / pure-ops for an engineer), avoided-domain companies (defense / hardware / automotive), profile.md allergies, and a role explicitly at a user-named hard-skip location. **This keep-bias is about LOCATION and ambiguous titles only — it does NOT relax role-type or domain skips: a sales role is still not_a_match, and a defense/hardware/automotive company's roles still skip on domain, regardless of how the location reads.**

**Title-classification calibration:**

- **Product Manager titles are NOT engineering.** "Product Manager" / "Senior Product Manager" / "Group PM" / "Director of Product" → \`skip:not_a_match\` for engineering-targeting users (anyone whose thesis specifies SWE/EM/Eng Lead/CTO/etc.), unless profile.md explicitly includes PM in the target-role list. PM-skip rationale: "Product role; user targets engineering." NOTE: Engineering Manager (EM) is a separate role-type from Product Manager and IS often in scope for engineering-targeting users — don't conflate the two.

- **Honor explicit allergies in profile.md.** If profile.md names a role type as avoid/low-priority ("FDE / Forward Deployed Engineer", "Customer Engineer", "Applied AI", etc.), those titles must \`skip:not_a_match\` regardless of how on-thesis the company is. The user has already learned this isn't a fit. Rationale: "User has flagged \\<role-type\\> as a low-priority/avoid pattern."

- **Eng-adjacent borderline titles where body-read is needed → \`keep\`.** Titles that COULD be product engineering or COULD be customer-facing / CRM-admin / internal-IT roles are ambiguous from metadata alone — let the shortlist sub-agent decide from the body. Examples:
  - "Design Engineer", "Forward Deployed Engineer" (when profile.md hasn't named FDE as avoid), "Field Engineer", "Solutions Engineer" — span IC engineering vs. customer-facing.
  - "Salesforce Platform Engineer", "Salesforce Developer" — title says "Platform Engineer" / "Developer", but the "Salesforce" prefix often means CRM-stack admin work; shortlist body-read will reveal whether it's product platform or CRM admin.
  - "Senior Systems Engineer, Corporate Engineering" / "Corporate Engineering" titles — could be product systems eng or internal IT; the body will say.
  Titles like "Design Engineer" and "Field Engineer" are easy to over-skip on title alone, and a blanket CRM/IT skip rule wrongly catches genuine platform-engineering roles — give these a body-read.

- **Hierarchy of signals**: profile.md role-allergies > profile.md target-roles > title heuristics. When they conflict, the more user-specific signal wins.

**Location — defer when the arrangement is UNKNOWN; skip only when it's known-incompatible.**

You see only the scraped metadata (the location label + the attribute bag). Usually that's just the HQ/office city, which does NOT tell you whether the role is remote-, hybrid-, or relocation-eligible — only the body does. So the DEFAULT is to defer the geo call to the scan body-read. Per job:
1. **Mentions "remote"** ("Remote", "Remote (US)") → **keep**.
2. **A workable location** — the user's home metro, their stated target metro, or a city they've said they'll relocate to (e.g. "New York" / "NYC" for a user who wrote "NYC or remote, relocating to NYC") → **keep**. A relocation target is a place they WANT to be; keep it even if it's tagged on-site.
3. **A bare city with NO arrangement signal — ANY city, US or foreign** ("San Francisco", "Seattle", "Toronto, Canada", "London, UK", "Berlin", "Bangalore") → **keep**. A bare city is NOT a location_mismatch: you can't tell it isn't fully remote or relocation-eligible, and remote may be the only arrangement under which it fits — so let it slide; the scan body-read makes the real call. **A foreign / non-US city is still just a bare city → keep.** Do NOT skip a bare city on location, ever.
4. **A non-target city WITH a clear incompatible arrangement** stated in the metadata — a "Hybrid" / "On-site" tag on the label ("Austin (On-site)", "Foster City, CA • Hybrid"), or a \`remote=onsite\` / \`remote=hybrid\` attribute — → **skip:location_mismatch**, but ONLY when that city is one the thesis rules out AND the thesis gives no sign the user would relocate there. On-site/hybrid means being IN that city — only "remote" rescues an otherwise-ruled-out city. If the thesis leaves relocation open, keep it.
5. **A user-named HARD-skip location** ("hard no on LA") → **skip:location_mismatch** even without an arrangement tag.

**Stay keep-biased for the UNKNOWN case.** The most common over-skip is skipping a bare-city engineering role because its HQ isn't the target metro — don't, and a foreign-city bare label is the most-penalized version of that. A bare city with no arrangement signal is a KEEP regardless of country; only skip:location_mismatch when the metadata POSITIVELY states an on-site/hybrid arrangement at a ruled-out city, or names a hard-skip location. Under-skipping an unknown-arrangement role is safe (the scan body-read catches it); over-skipping a bare city is not. Surface a per-job skip reason whenever you do skip.

**Location and role-type are independent decisions.** Decide role-type FIRST, then location. "Remote" only protects against \`location_mismatch\` — it does NOT turn an off-thesis role into a keep: a Remote "Program Manager" or "Director, Strategy" for an engineering-targeting user is still \`skip:not_a_match\` on role type. Conversely, a **bare-city** role ("San Francisco") that IS the user's target role-type should be KEPT — the city alone is not a disqualifier, so don't skip a core-thesis engineering role just because it's in a non-target city. (The paired error to avoid: keeping remote business-ops roles while skipping on-thesis SF engineering roles — exactly backwards.)

**Domain hard-skips (honor explicit thesis dead-ends):**

If profile.md names a domain as a hard avoid / dead-end (e.g. "no defense", "not hardware/automotive"), every role in that domain is \`skip:not_a_match\` — even when the TITLE looks like a perfect fit (a defense company's "Senior Software Engineer" is still defense). Work out the domain from what you were actually given, in this order: the "What <company> does" line and the notes on the company (when present, these are the reliable signals — one says what the business is, the other is the user's own read on it), then the company name and the department/team/division metadata. A company like "Northwind Systems" with divisions such as "Air Defense", "Autonomous Systems", "Maritime Dominance", or "Mission Software" is squarely defense → skip every role \`skip:not_a_match\`. **With no description, no company note, and no telling division names, you do not know the domain** — an unfamiliar name that merely *sounds* industrial or defense-ish is not evidence, so keep those roles and let the scan body-read decide. (A name that says it outright — "… Defense Systems", "… Robotics" — IS evidence, as are divisions like "Air Defense" or "Autonomy & Weapons Systems".) When the whole company sits in an avoided domain, an on-thesis title or a remote/NYC location never rescues it — the domain veto wins. That still comes out as N job-level skips and nothing more — you do not escalate it to a verdict about the company.`;
}
