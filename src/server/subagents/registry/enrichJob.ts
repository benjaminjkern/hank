// Scan-step pass 1: ENRICH (transform sub-agent, user-independent).
//
// Reads ONE job's posting body and produces a terse, lossless prose summary plus
// the scalars the posting actually states (comp / location / remote / seniority /
// required-YoE / employment-type / department). The output describes the POSTING,
// not a candidate — which is why the caller can persist it on the global `Job`
// row and reuse it for every user watching that company, so the expensive
// full-body read happens at most once per Job, ever.
//
// Why it exists: downstream user-dependent steps (the scan MATCH pass and the
// shortlist rollup) read the summary instead of `rawContent`, which both cuts
// tokens and lets the match pass run as a cheap per-job fan-out. A DB scan found
// ~65% of jobs with no `compensation` column DO state comp in the body —
// extracting it here is the single biggest data win.
//
// Reads and writes nothing. Cache-hit detection, the column-backfill rule, and
// the `Job` update live with the caller (procedures/registry/scan/, in
// applyJobEnrichment.ts).

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

// Metadata-grade compression + extraction, not judgement — the summary just has
// to keep every concrete fact. Even so this stays on pro: tried on flash and
// REVERTED, because it's self-contained with no verification loop to catch
// flash's fabrication (pro has minor residual scalar wobble, no fails).
const MODEL: LlmModel = "deepseek-v4-pro";
const MAX_TOKENS = 2048;

// This sub-agent's own output vocabulary, not a product-wide one: nothing
// persists a `remote` enum. The caller reads it once to fold an arrangement tag
// into `locationAndArrangement`, then it rides along in the opaque
// `enrichedAttributes` bag.
const REMOTE_VALUES = ["remote", "hybrid", "onsite"] as const;
type RemoteValue = (typeof REMOTE_VALUES)[number];

export type EnrichScalars = {
  comp: string | null;
  location: string | null;
  remote: RemoteValue | null;
  seniorityLevel: string | null;
  requiredYoE: number | null;
  employmentType: string | null;
  department: string | null;
};

// The posting as the model sees it: the structured fields the ATS already gave
// us (so it doesn't restate them) plus the body to compress. No
// `enrichedAttributes` — that bag is this sub-agent's own output.
export type EnrichJobInput = RoleAttrs & {
  title: string;
  attributes?: unknown;
  body: string;
};

// On failure the result's `status` carries the Anthropic status of an APIError
// (429/529 → the caller's fan-out aborts and resumes from cache next pass).
export type EnrichJobOutput = { summary: string; scalars: EnrichScalars };

const COMMIT_ENRICHMENT_SCHEMA: SubAgentOutputSchema = {
  name: "commit_enrichment",
  description:
    "Emit the enrichment for this one posting: a terse lossless summary plus any scalar fields the posting actually states. This is NOT a fit judgement — never reference a candidate. Omit a scalar entirely when the posting doesn't state it (don't guess comp, don't infer a level that isn't there).",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Terse, lossless prose summary of the posting. DROP boilerplate (EEO statements, generic benefits lists, company-mission marketing, 'how to apply' instructions, legal footers). KEEP every concrete fact: responsibilities, required + preferred qualifications, seniority/level signals, required years of experience, tech stack/tools, team/org context, location & remote policy, compensation, employment type, and anything unusual or specific. Write it dense — the goal is to let a later step decide fit WITHOUT re-reading the original body. No candidate references; this is about the role only.",
      },
      comp: {
        type: "string",
        description:
          "Compensation exactly as stated in the body (e.g. '$180k–$220k base', '€90k', '$50/hr'). Omit if the posting states no comp.",
      },
      location: {
        type: "string",
        description:
          "Human-facing location that blends PLACE + WORK ARRANGEMENT — this becomes the `locationAndArrangement` value shown to the user, so ALWAYS fold in the arrangement when the posting states one. MUST reflect the role's actual work arrangement and must NOT over-claim remote. Genuinely doable from anywhere → 'Remote (US)' / 'London or remote (UK)'. HYBRID or tied to an office → name the city + arrangement ('Hybrid (SF)', 'SF or NYC (hybrid)', 'NYC (on-site)', 'Toronto, Canada (on-site, 3 days/week)'); do NOT write 'Remote (US)' for a hybrid/onsite role — that fabricates a remote-from-anywhere arrangement the posting doesn't offer. A confirmed on-site/in-office role → name the city AND say on-site ('Toronto, Canada (on-site)') — do NOT return a bare city for a role the body says is on-site, because a bare city reads as possibly-remote downstream. Office-bound with no remote signal at all → the city ('Bay Area, CA'). Keep this consistent with the remote scalar. Omit only if the posting states no location whatsoever.",
      },
      department: {
        type: "string",
        description:
          "Team / org / department the role sits in, when the posting states it (e.g. 'Infrastructure Engineering', 'Platform', 'Growth'). Used to backfill the display column when the ATS didn't provide one. Omit if the posting gives no team/department signal.",
      },
      remote: {
        type: "string",
        enum: REMOTE_VALUES as readonly string[] as string[],
        description:
          "Work arrangement when the posting makes it clear. Omit if ambiguous/unstated.",
      },
      seniorityLevel: {
        type: "string",
        description:
          "Level as the posting frames it (e.g. 'Junior', 'Mid', 'Senior', 'Staff', 'Principal', 'Lead', 'Manager', 'Director', 'VP'). Omit if the posting gives no level signal.",
      },
      requiredYoE: {
        type: "number",
        description:
          "Minimum years of experience the posting REQUIRES, as a number (e.g. 5 for '5+ years'). Omit if not stated.",
      },
      employmentType: {
        type: "string",
        description:
          "e.g. 'full-time', 'contract', 'part-time', 'internship'. Omit if not stated.",
      },
    },
    required: ["summary"],
  },
};

type CommitEnrichmentInput = {
  summary?: string;
  comp?: string;
  location?: string;
  remote?: string;
  seniorityLevel?: string;
  requiredYoE?: number;
  employmentType?: string;
  department?: string;
};

export const enrichJobSubAgent: SubAgentDef<
  EnrichJobInput,
  CommitEnrichmentInput,
  EnrichJobOutput
> = {
  name: "enrich_job",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  // Extraction, not judgement: every field is stated somewhere in the posting or
  // is absent, and the def's own rule is to leave it null rather than infer. A
  // scratchpad would be the model narrating a lookup.
  reasoning: {
    mode: "none",
    why: "Pulls stated facts out of one posting — there is no call to weigh, only text that either says the thing or doesn't.",
  },
  system: buildSystemPrompt,
  userContent: buildUserContent,
  outputSchema: COMMIT_ENRICHMENT_SCHEMA,
  caption: (input) => `Enriching "${input.title}"…`,
  parse(i) {
    const summary = (i.summary ?? "").trim();
    // A summary is the whole product — an empty one is a failed run, not an
    // enrichment with nothing in it.
    if (summary.length === 0) {
      throw new Error("enrichment returned an empty summary");
    }
    return {
      summary,
      scalars: {
        comp: cleanStr(i.comp),
        location: cleanStr(i.location),
        remote: (REMOTE_VALUES as readonly string[]).includes(i.remote ?? "")
          ? (i.remote as RemoteValue)
          : null,
        seniorityLevel: cleanStr(i.seniorityLevel),
        requiredYoE:
          typeof i.requiredYoE === "number" && Number.isFinite(i.requiredYoE)
            ? Math.round(i.requiredYoE)
            : null,
        employmentType: cleanStr(i.employmentType),
        department: cleanStr(i.department),
      },
    };
  },
};

// These are short scalar fields (comp / location / seniority / employment type)
// that never legitimately contain markup. When the extraction model falls back to
// the XML tool-call format ("<parameter name=...>value</...>") its serialization
// can bleed tag fragments into a value — e.g. employmentType came back as
// `full-time</employmentType>\n<parameter name="location">Remote (US)`. Strip a
// leading opener tag, then drop everything from the first remaining "<", so no
// markup ever reaches the Job row or the user-facing shortlist.
function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let t = v.replace(/^\s*<[^>]*>\s*/, "");
  const lt = t.indexOf("<");
  if (lt !== -1) t = t.slice(0, lt);
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function buildUserContent(input: EnrichJobInput): string {
  // Absent attributes are shown as "(none on file)" rather than omitted: this is
  // the extraction pass, so knowing which fields are MISSING is what tells it
  // what's worth pulling out of the body.
  const knownFields = [
    ...roleAttrPairs(input, { emptyPlaceholder: "(none on file)" }),
    ...attributePairs(input.attributes),
  ];

  return [
    `# Job title\n${input.title}`,
    "",
    "# Already-known structured fields (from the ATS list/detail response)",
    knownFields.join("\n"),
    "",
    "# Posting body (rawContent)",
    input.body,
    "",
    "Produce the summary and extract any scalars the body states. Pay special attention to compensation — boards frequently omit it from structured fields but state it in the body. Don't restate a field as a scalar if it's already known above unless the body is more specific.",
  ].join("\n");
}

function buildSystemPrompt(): string {
  return `You compress and structure ONE job posting. You are NOT judging fit for any candidate — there is no candidate here. Your only job is to (1) write a terse, lossless summary of the posting and (2) pull out the few scalar fields the posting explicitly states. Return everything via the commit_enrichment tool.

# The summary
- DROP: EEO/equal-opportunity statements, **benefits lists (healthcare, parental/family leave, fertility, wellness stipends, 401k, PTO — boilerplate even when specific or generous)**, company-mission marketing copy, "how to apply" instructions, legal footers, and anything a different posting would say verbatim.
- KEEP: responsibilities, required AND preferred qualifications, seniority/level signals, required years of experience, tech stack / tools / languages, team & org context (team size, who you report to, stage), location and remote policy, compensation, employment type, and anything specific or unusual about the role.
- Write it DENSE. A later step must be able to decide whether this role fits a candidate using ONLY your summary — so losing a concrete fact is the failure mode, but so is padding it with fluff. Terse and complete.

# The scalars
- Only emit a scalar when the posting actually states it. OMIT (don't pass) the field otherwise. Never guess compensation; never invent a seniority level the posting doesn't signal.
- comp: copy the figure/range as written. requiredYoE: the minimum the posting requires, as a number. remote: remote/hybrid/onsite only when unambiguous. department: the team/org the role sits in (e.g. "Infrastructure Engineering") when stated.
- **A location is not a work-arrangement.** When the posting states only a city/location with no remote/hybrid/onsite language, OMIT the remote scalar — do NOT infer "onsite" from the mere presence of a location line. Likewise OMIT employmentType unless the posting actually says "full-time" / "contract" / "part-time" / "internship" — never default to "full-time" because most jobs are.
- **Company culture copy is NOT a role arrangement — this is the most common remote over-claim.** Statements about the COMPANY ("we're distributed by intention", "remote-first culture", "we hire the best people wherever they are", "globally distributed team", "async by default") describe the org's philosophy, NOT this specific role's work arrangement. They do NOT license \`remote='remote'\` or a "Remote (US)" location. Set remote (and fold "Remote" into the location string) ONLY when the posting states THIS ROLE's arrangement — an explicit line like "This role is fully remote", "Remote (US)", "Hybrid, 3 days in SF", "On-site in NYC", or a structured remote field. If the only remote-sounding language is about the company/culture and the role itself just names a city (or names nothing), OMIT remote and return the plain city. When the role's arrangement is genuinely unstated, omit — never guess it from vibes.
- **location is \`locationAndArrangement\`: it MUST blend PLACE + WORK ARRANGEMENT — and must not over-claim remote.** This string is shown to the user as the role's location AND read by the downstream geo filter, so a bare city is actively misleading when the body pins the arrangement. ALWAYS fold the arrangement in when the posting states one: doable from anywhere → "Remote (US)", "London or remote (UK)"; HYBRID or tied to an office → city + arrangement ("Hybrid (SF)", "SF or NYC (hybrid)", "NYC (on-site)"); **confirmed ON-SITE/in-office → name the city AND say on-site ("Toronto, Canada (on-site)", "Austin, TX (on-site, 3 days/week)") — do NOT return a bare city for a role the body says is on-site.** NEVER write "Remote (US)" for a hybrid / #LI-Onsite role — that invents a remote-from-anywhere arrangement the posting doesn't offer. Return a plain city ("Bay Area, CA") only when the role is office-bound with genuinely no remote/hybrid/on-site signal at all. Keep this string consistent with the remote scalar you set.

# Discipline
- No candidate references, no "good fit"/"strong match" language — that's a later step's job.
- Don't editorialize. Summarize what's there.`;
}
