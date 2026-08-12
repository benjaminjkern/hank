// Shortlist ROLLUP for one company (judgement sub-agent, user-dependent) — the
// SEED of the shortlist board.
//
// Ranks the roles that already survived the absolute per-job scan and proposes
// a stance for each: pick / borderline / pass. RELATIVE only: metadata
// filtering is preScanJobBatch.ts (add/rescan time) and absolute per-job match
// is scanJob.ts (the scan step), so every candidate here already carries a
// STRONG/POSSIBLE/WEAK verdict. The question is "which of these, and how do
// they compare" — never "does this one qualify".
//
// Its output is a PROPOSAL, not a decision. The caller writes each stance onto
// the board (procedures/registry/shortlist/seedBoardStances.ts, which also
// applies the pick ceiling); the user and Hank then negotiate over the board,
// and nothing changes status until Hank commits it
// (entities/companies/commitShortlist.ts). A `pass` closes the role only AT
// COMMIT — but every stance must be written as if it will stand, because an
// uncontested board is committed as-is.
//
// Reads nothing and writes nothing. This file owns the prompt, the output
// schema, and the stance parsing — nothing else.
//
// TRANSFORM class: no read tools, one turn. The memory paths its prompt names —
// profile.md, companies/{slug}.md, and jobs/{slug}.md for the candidates — are
// all front-loaded, so there is nothing left for a read loop to reach.
// Front-load anything else you need rather than handing the tools back.
//
// The model makes ONE judgement per job and nothing else. In particular it does
// not rule on the pool as a whole: "none of these are worth applying to" is
// derived downstream from the stances, not asked for, so it can't disagree
// with them.
//
// Every answer is about the JOBS. Ending a COMPANY is the user's call, via
// Hank's close_company / caught_up_company / pause_company levers — a per-job
// ranking says nothing about whether the company is worth watching, so this
// sub-agent neither closes a company nor suggests it.

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
import { USER_FACING_VOICE } from "@/server/subagents/lib/voice";

// flash 4/0/0 against self-contained fixtures (2026-06-19).
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 4096;

// One role as the model sees it.
export type ShortlistCandidate = RoleAttrs & {
  id: string;
  title: string;
  // The enrich pass's compressed posting — lossless by construction, and what
  // this pass reads. `rawContent` is the fallback for a role enrichment never
  // reached (no body, or the pass failed); `renderCandidateBody` picks.
  enrichedSummary: string | null;
  rawContent: string | null;
  attributes?: unknown;
  // Kept even though the summary covers the same ground: this pass never sees
  // the body, and the extracted scalars are structured where the prose is
  // ambiguous (`remote=onsite` vs a bare city).
  enrichedAttributes?: unknown;
  // The scan step's absolute verdict, carried through as the ranking prior.
  matchBucket: string | null;
  matchScore: number | null;
  matchReason: string | null;
  // This role's own memory note (jobs/{slug}.md), when one exists. Usually
  // absent: job notes get written once the user is pursuing a role, which is
  // downstream of shortlisting.
  jobNote?: string | null;
  // Why the user passed on this role in an EARLIER round (their demotion /
  // committed set-aside). Present only on a re-rank; a downgrade signal, never
  // grounds for `pass` — see "A role they already passed on".
  priorDeferNote?: string | null;
  // The user started writing this application and never sent it. The mirror of
  // priorDeferNote and points the other way: they committed to this role once
  // already, so it takes a real reason to rank it below roles they haven't.
  unfinishedApplication?: boolean;
};

export type ShortlistJobsInput = {
  companyName: string;
  // What the company actually DOES, in one line (Company.description) — same
  // signal preScanJobBatch and scanJob get, so a domain judgement here rests on
  // the same evidence rather than on guessing from the name.
  companyDescription: string | null;
  candidates: ShortlistCandidate[];
  profile: string;
  resume: string;
  companyNote: string | null;
  // Free-form steer forwarded from the chat ("infra roles only").
  extraContext?: string;
};

const SHORTLIST_STANCES = ["pick", "borderline", "pass"] as const;
export type ShortlistStance = (typeof SHORTLIST_STANCES)[number];

export type ShortlistJobsOutput = {
  // One entry per input candidate, in order. Positions the model left unfilled
  // default to `borderline` — an under-filled array must never silently drop a
  // candidate onto a stance nobody chose, and `borderline` is the only stance
  // that decides nothing.
  verdicts: Array<{ stance: ShortlistStance; reason: string | null }>;
  // Convenience projections of `verdicts` onto the candidate ids.
  pickedJobIds: string[];
  passedJobIds: string[];
  reasons: Record<string, string>;
  proposalNote: string | null;
};

// Stance-per-item shape (see preScanJobBatch.ts for the rationale). The model
// emits one stance per numbered candidate and the caller maps positions back
// to jobIds. Free recall against opaque id strings loses candidates (empty
// picks despite real matches); forced per-position stances with paired reasons
// make every candidate explicit, and the reasons render on the board next to
// each role.
const PROPOSE_SHORTLIST_STANCES_SCHEMA: SubAgentOutputSchema = {
  name: "propose_shortlist_stances",
  description:
    "Propose the shortlist board. Emit one {reason, stance} per numbered detail candidate (1..N from the list above), in order. `verdicts` MUST have exactly N entries — one per job. `pick` = recommend applying. `borderline` = worth a look, not recommended. `pass` = recommend against ever applying. The stances land on a board the user reviews and can change before anything is final, but write each one as if it will stand — an uncontested board is committed as-is, and a standing `pass` closes the role. Each `reason` is one short user-facing sentence shown next to the role. `proposalNote` is the brief shared top-line — keep it short (one phrase), since per-job reasoning lives inline.",
  inputSchema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        description:
          "One entry per detail candidate, in order. Length MUST equal the candidate count. Each entry is { reason: string, stance: 'pick'|'borderline'|'pass' } — write the `reason` FIRST, then set `stance` to match it. The reason is a one-sentence user-facing rationale shown next to the role on the board — natural language, no enum names or tool jargon. Aim for 3-5 picks when the pool supports it — pick every role that genuinely fits, up to a ceiling of 5. If MORE than 5 genuinely fit (a big mostly-on-thesis board), keep the 5 strongest and mark the rest 'borderline'; never undershoot the number that truly fit on a small pool. THE PASS BAR: 'pass' means there is no reason this person would EVER apply to this role — a hard disqualifier in the posting itself (wrong function, a location they can't work, a level far outside their range). If your pass stands, the role is closed when the board is committed. Outranked by a better option here, thin-but-plausible, or anything you'd judge differently on a different day is 'borderline' — that keeps it in play for the user to decide. When unsure, 'borderline'.",
        items: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: `Write this FIRST, before \`stance\`. One short user-facing sentence explaining the fit for this job; the \`stance\` must follow from it. Renders next to the role on the board. ${USER_FACING_VOICE} Examples: 'Direct fit — IC backend infra, NYC, your seniority.' / 'London-only, off your remote/NYC thesis.' / 'Director-level might be a stretch but CPG vertical is right.'`,
            },
            stance: {
              type: "string",
              enum: SHORTLIST_STANCES as readonly string[] as string[],
              description:
                "Set AFTER `reason`, matching it. 'pick' = recommend applying. 'borderline' = in play, the user decides. 'pass' = recommend against ever applying — meet the pass bar described on `verdicts` before using it.",
            },
          },
          required: ["reason", "stance"],
        },
      },
      proposalNote: {
        type: "string",
        description:
          "ONE short phrase shown as the board's top description — e.g. 'Three IC backend roles matching your platform focus' or 'Two NYC ad-sales roles, both on-thesis'. Keep it terse: per-job reasoning lives inline. If you state a count here ('Three…', 'Four…'), it MUST equal the number of 'pick' stances you emit — don't say 'eight picks' and then pick twelve. If you marked every job 'pass', write it as a standalone sentence naming what you looked at and the shared reason none of it applies ('Read all 3 — they're London-based contract roles, none of them work for you.').",
      },
    },
    required: ["verdicts", "proposalNote"],
  },
};

const SYSTEM = `You are proposing the shortlist from a pool of jobs at ONE company. Each job comes with a compressed summary and a "Scan verdict" (STRONG / POSSIBLE / WEAK + a one-line reason) from an earlier per-job pass that already read the full posting and ALREADY filtered out clear disqualifiers (wrong role type, geo that can't work, way-off seniority, hard-passes). So every job you see is at least plausible. Your job is RELATIVE: rank these survivors against each other and propose which ones to actually apply to.

# Your remit is these roles, not this company
You propose which of the jobs below the user should apply to — if any. That is the whole question. Whether the company stays on their list, gets set aside, or gets dropped is NOT your call and is not yours to suggest, even when nothing in the pool fits: a snapshot of today's openings says nothing about whether the company is worth watching, and the user has their own levers for that. So never recommend closing / dropping / pausing a company, and never ask whether to keep watching it.

**Finishing:** call \`propose_shortlist_stances\` with exactly one {reason, stance} per numbered candidate, in order. Job 1 → verdicts[0], etc. Three stances:
- \`pick\` — you're recommending they apply.
- \`borderline\` — worth a look; the user's call.
- \`pass\` — you're recommending they never apply to this role. See "The pass bar" below.

Your stances land on a board the user reviews with their own hands — they can promote, demote, or push back on any of them before the shortlist is locked in. That safety net is NOT a reason to be sloppy: an uncontested board is committed exactly as you wrote it, so write every stance as if it will stand.

Each \`reason\` is one short user-facing sentence shown next to that role ("Direct fit — IC backend infra, NYC, your seniority." / "Solid but a level junior to your target."). \`proposalNote\` is a terse shared top-line ("Three IC backend roles matching your platform focus").

# The pass bar
A standing \`pass\` closes the role when the board is committed. So the bar is **"there is no reason this person would EVER apply to this role"**, not "this one is weaker than the others." A hard disqualifier in the posting itself clears that bar: wrong function, a location they can't work, a level far outside their range. Outranked by something better here, thin-but-plausible, or anything you'd judge differently on a different day is \`borderline\` — that keeps it in play and lets them decide. **When you're unsure, \`borderline\`.**

Expect FEW passes, often none. The scan pass ahead of you already closed the clear disqualifiers, so a role reaching you with a STRONG or POSSIBLE scan verdict is one that pass judged plausible — passing on it is a claim that pass got it wrong. That's sometimes true, and when it is, the \`reason\` has to name the disqualifier plainly ("Tokyo-only, and the posting says no relocation").

# How to rank
- **Lean on the scan verdict as your prior.** STRONG → pick unless something about the rest of the pool changes the picture. POSSIBLE → judge on fit + comp + level. WEAK → usually \`borderline\`, occasionally \`pick\` if the pool is thin and it's the best available.
- **Aim for 3-5 \`pick\` stances** when the pool supports it. Don't squeeze to zero — these already passed an absolute filter. But don't pick a stretch just to hit a count either. Pick every role that genuinely fits (function + level + comp + location); if exactly 2 fit, pick 2 — never undershoot the number that truly fit.
- **5 is a hard ceiling — but ONLY a ceiling.** It bites on the big-board case: when a large pool is mostly on-thesis and MORE than 5 look strong, don't pick them all — rank them against each other and keep the 5 SHARPEST, marking the rest \`borderline\` (still on the board, the user can promote them). Over-selecting from a big plausible pool (picking 12 of 25) is the failure to avoid. This NEVER forces a small pool below its genuine-fit count.
- **Relative reasoning is your value-add.** If two roles are near-duplicates (same team, adjacent titles), pick the better-fit one and mark the other \`borderline\` with a note. Prefer roles with explicit on-floor comp, the user's target level, and a location/remote setup that works.
- **The user's resume function is a strong signal.** If the resume shows them currently doing this role's function at this level, that's a \`pick\` — their stated wish to move elsewhere is a tilt, not a veto. The board lets them demote it.
- **Calibrate level AND management scope — upward, not just downward.** The pool already cleared "way-off seniority," but within it, grade how big a jump each role is from what the resume + notes show the user *actually operating at* — and apply the same skepticism going up as you do going down (you already flag "a level junior to your target"; flag "a level above" just as readily). A title qualifier is a real step: "Senior/Staff/Principal" IC and "Senior/Sr./Director" manager sit above the base role, and at a large company a "Senior Engineering Manager" is usually second-line (managing managers / a whole org), not a first-time team lead. For any MANAGEMENT role, weigh its scope — team size, org level, company size — against the largest span the user has genuinely led: e.g. "managed a team of 4 at a seed startup" does NOT translate to a ready Sr. EM owning a cross-org platform at a 2,000-person public company. A stated track preference ("wants EM / leadership") tells you the DIRECTION they want, not that every senior rung on that track is in range — never let "they want leadership" auto-upgrade a scope-stretch into a pick, and don't justify a pick on title or comp alone. A genuine reach on level or scope is a \`borderline\`, not a \`pick\`; if you do pick it, the reason must name the stretch honestly ("bigger org than you've run — a reach, but dead-on for your domain"), never paper over it.
- **Ground every reason in real signal.** Each \`reason\` and the \`proposalNote\` must trace to this job's posting, the user's resume, or their memory notes — never invent experience the user doesn't have (e.g. don't claim Stripe/billing background to justify a billing role unless it's actually in the resume). If a pick's fit rests on experience you can't find, that's a \`borderline\`, not a fabricated \`pick\`.

# Written-down constraints outrank a posting's own copy
A structural constraint stated in the user's profile or in the notes on this company ("SF-only, confirmed", "no on-site outside NYC") is HIGHER authority than what a role's summary text implies. The scan pass applies these per-job, but you see the whole pool — where one of them clearly contradicts a row the scan let through, that row is \`borderline\` (or \`pass\` if it's a hard disqualifier), not \`pick\`. Judge only against constraints actually written down for you; do not infer a company-level pattern from the shape of the pool itself.

Never ship a pick with a "confirm location before applying" caveat — if you'd warn the user about a structural issue you could detect, downgrade the pick instead.

# A role they already passed on
Some roles carry a "Passed over earlier" note — the user saw this exact role in a previous round and set it aside. Treat it as a real signal about THIS role and nothing wider: if the note names a durable disqualifier ("wants no on-site days"), that still holds; if it says the pass had no stated reason, it means little on its own.

**A prior set-aside is never grounds for \`pass\`.** They set it aside, which is not the same as "would never apply" — the round is being re-run precisely because something changed. Keep it \`borderline\` and name the history in the reason ("You set this one aside last time — still here if the remote policy is workable"), and let them decide.

# A role they started applying to
Some roles are marked "Application started and never finished" — the user committed to this one in an earlier round and began writing, then stopped. That is the strongest interest signal in the pool, and it points the OPPOSITE way from a prior set-aside: rank it as you would a role they'd told you they wanted.

You may still rank it anywhere, including \`pass\` — an abandoned draft often means they went off it, and a stale half-application is worth clearing out. But it takes a reason you can state: something in the pool now beats it, or the role itself doesn't hold up on a re-read. Never rank one down silently, and never treat "they didn't finish" as evidence on its own — a draft stops for a hundred reasons that say nothing about the role. Whatever you land on, **say in the \`reason\` that they'd started this one**, so they can tell you if they actually applied.

# \`borderline\` is a comparison, not a shrug
\`borderline\` means "don't apply to this one YET" — and "yet" only means something when something else on this board IS worth applying to first. Its whole job is queueing: these are fine, those are better, do those now.

So when nothing here is a \`pick\`, **do not fall back to \`borderline\` for a role you feel lukewarm about**. "Eh, maybe something better turns up" is not a decision — it parks a role the user has to re-decide later with no more information than you have right now. Force it: either the role is worth applying to even in a weak field (\`pick\`), or it isn't worth their time (\`pass\`). Nothing better is coming from this company today, and that IS the information.

\`borderline\` still survives a board with no picks, but only for a reason you can state in the \`reason\`:
- **A specific unknown could flip it** — something the posting doesn't settle that the user can answer in one sentence. Name the missing fact.
- **They already committed to it once** — set aside in an earlier round, or an application they started. Those carry their own rules above.
- **Their notes say hold, not close.**

If you can't name which of those applies, it's a \`pick\` or a \`pass\`.

# Reasons render to the user
Write every \`reason\` and the \`proposalNote\` in natural English — no stance labels ("pick"/"pass"/"borderline" as jargon), no scan jargon ("STRONG"), no status vocabulary, no tool names. They appear next to each role on the board.

# What you're working from
Everything you need is above: the pool with its scan verdicts, what the company does, the user's profile and resume summary, the notes on this company, and any note on an individual role. You have no tools and one turn — read it, reason it through in \`analysis\`, and commit. Where the context genuinely doesn't settle a question, that uncertainty is what \`borderline\` is for; never invent the missing fact.`;

function renderCandidates(candidates: ShortlistCandidate[]): string {
  return candidates
    .map((c, idx) => {
      const meta = [
        ...roleAttrPairs(c),
        ...attributePairs(c.attributes),
        ...attributePairs(c.enrichedAttributes),
      ];
      const header = `## ${idx + 1}. ${c.title}${meta.length ? `\n(${meta.join(", ")})` : ""}`;
      // The scan step's per-job match verdict is a prior — surface it so the
      // ranker can lean on STRONG/POSSIBLE/WEAK + the one-line reason rather
      // than re-deriving fit from scratch.
      const matchLine = c.matchBucket
        ? `Scan verdict: ${c.matchBucket}${c.matchScore != null ? ` (${c.matchScore}/100)` : ""}${c.matchReason ? ` — ${c.matchReason}` : ""}`
        : "Scan verdict: (none — judge from the summary)";
      // Per-role history, when there is any. Both are about THIS role only —
      // the prompt's "A role they already passed on" section governs how far
      // the pass note carries.
      const priorLine = c.priorDeferNote?.trim()
        ? `\nPassed over earlier: ${c.priorDeferNote.trim()}`
        : "";
      const unfinishedLine = c.unfinishedApplication
        ? "\nApplication started and never finished."
        : "";
      const noteLine = c.jobNote?.trim()
        ? `\nYour notes on this role:\n${c.jobNote.trim()}`
        : "";
      return `${header}\n${matchLine}${priorLine}${unfinishedLine}${noteLine}\n\n${renderCandidateBody(c)}`;
    })
    .join("\n\n---\n\n");
}

// Read the enriched summary, not the full body: it's lossless by construction
// and a fraction of the tokens. Fall back to the raw posting only for a role
// enrichment never reached, labelled so the model knows it's reading something
// longer and noisier than the other candidates.
function renderCandidateBody(c: ShortlistCandidate): string {
  const summary = c.enrichedSummary?.trim();
  if (summary) return summary;
  const raw = c.rawContent?.trim();
  return raw
    ? `(not yet enriched — raw posting follows)\n${raw}`
    : "(no posting content stored — likely a manually-created job.)";
}

function renderUserContent(input: ShortlistJobsInput): string {
  const sections: string[] = [
    `# Detail candidates at ${input.companyName} (${input.candidates.length} jobs)`,
    "",
    renderCandidates(input.candidates),
  ];
  if (input.companyDescription?.trim()) {
    sections.push(
      "",
      `# What ${input.companyName} does`,
      input.companyDescription.trim(),
    );
  }
  sections.push(
    "",
    "# Candidate profile (profile.md)",
    input.profile,
    "",
    "# The candidate's background",
    input.resume,
  );
  if (input.companyNote) {
    sections.push(
      "",
      "# Company-specific notes (companies/{slug}.md)",
      input.companyNote.trim(),
    );
  }
  if (input.extraContext) {
    sections.push(
      "",
      "# Additional context (from this session)",
      input.extraContext.trim(),
    );
  }
  sections.push(
    "",
    `Call propose_shortlist_stances with a verdicts array of exactly ${input.candidates.length} entries (one {reason, stance} per numbered candidate, in order) and a proposalNote. A standing pass closes that role when the board is committed — meet the pass bar.`,
  );
  return sections.join("\n");
}

function asStance(value: unknown): ShortlistStance {
  return SHORTLIST_STANCES.includes(value as ShortlistStance)
    ? (value as ShortlistStance)
    : // A missing or unrecognized position stays in play undecided, so an
      // under-filled array can never silently pick or pass a candidate.
      "borderline";
}

// The raw propose_shortlist_stances payload, before position→jobId mapping.
type ShortlistStanceEmission = {
  verdicts?: Array<{ stance?: string; reason?: string }>;
  proposalNote?: string;
};

export const shortlistJobsSubAgent: SubAgentDef<
  ShortlistJobsInput,
  ShortlistStanceEmission,
  ShortlistJobsOutput
> = {
  name: "shortlist_jobs",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  // The ranking IS the work here, and it's comparative — which is exactly what
  // a per-item emission can't hold. Under a soft target a per-item shape drifts —
  // picking far more than the note says — because nothing makes the model
  // reconcile its count. A model that has to rank the pool in prose, name
  // where the ceiling falls, and count its own picks before it fills `verdicts`
  // can't drift from its own note that way.
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Work the pool before you emit a single stance. One short line per numbered candidate, in order: its scan verdict as the prior, then the ABSOLUTE question — does this role genuinely fit (function, level/scope vs what the resume shows the user actually operating at, comp, location)? End each line with 'fits' or 'no: <reason>'. Judge each on its own merits here; a role that fits is never demoted just for being second-best, and this step is not a ranking. THEN, for every 'no' line only, decide whether it is a NEVER no — is there a disqualifier in the posting itself that means this person would never apply to this role on any day? Write 'never' or 'not now' on each, defaulting to 'not now' — a 'no' that only means outranked or unexciting is always 'not now'. THEN count the 'fits' lines. If there are 5 or fewer, every one of them is a `pick` — that is the answer, however small. Only if MORE than 5 fit do you rank those against each other and keep the 5 sharpest, marking the rest `borderline`. Every 'never' is a `pass`; every 'not now' and every fit beyond the 5 is a `borderline`. Finish with one line: 'Picking N: <numbers>. Borderline: <numbers>. Pass: <numbers>.' N equals your 'fits' count (capped at 5) and equals the number of `pick` stances you emit — and any count you state in `proposalNote` must equal N too; don't describe a role as picked if you left it borderline.",
  },
  // No `maxTurns` and no `readTools`: this is a transform, and both default to
  // the one-shot shape. Don't hand the tools back without re-reading the class
  // note at the top of this file.
  system: SYSTEM,
  userContent: renderUserContent,
  outputSchema: PROPOSE_SHORTLIST_STANCES_SCHEMA,
  usageNotes: (input, turn) => `turn=${turn} company=${input.companyName}`,
  parse(out, input) {
    const raw = Array.isArray(out.verdicts) ? out.verdicts : [];
    const verdicts = input.candidates.map((_, i) => {
      const entry = raw[i];
      const reason =
        entry && typeof entry.reason === "string" && entry.reason.trim()
          ? entry.reason.trim()
          : null;
      return { stance: asStance(entry?.stance), reason };
    });

    const pickedJobIds: string[] = [];
    const passedJobIds: string[] = [];
    const reasons: Record<string, string> = {};
    verdicts.forEach((v, i) => {
      const jobId = input.candidates[i].id;
      if (v.stance === "pick") pickedJobIds.push(jobId);
      // `pass` is read off the stance ONLY — never inferred from "not picked".
      // A missing or unrecognized position already defaulted to `borderline` in
      // asStance, which is what keeps an under-filled array from passing on
      // anything.
      if (v.stance === "pass") passedJobIds.push(jobId);
      if (v.reason) reasons[jobId] = v.reason;
    });

    return {
      verdicts,
      pickedJobIds,
      passedJobIds,
      reasons,
      proposalNote: out.proposalNote ?? null,
    };
  },
};
