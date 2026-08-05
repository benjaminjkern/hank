// Application drafting sub-agent (judgement class).
//
// Writes ONE application artifact — the cover letter, or the answer to one
// short-answer question — for a job the decider already ruled `draft`. The
// caller front-loads the role, the posting, the user's résumé and notes, and a
// CATALOG of their past applications; the one read tool
// (`read_reusable_application`) fetches a prior letter or answer in full so the
// draft can be written in the user's own voice. The caller persists the result;
// this sub-agent writes nothing.

import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { readReusableApplicationTool } from "@/server/agent/tools/registry/readReusableApplication";
import { attributePairs } from "@/server/entities/jobs/attributePairs";
import {
  formatPastCoverLetterIndex,
  formatPastShortAnswersIndex,
  type PastDrafts,
} from "@/server/entities/jobs/pastDrafts";
import {
  roleAttrPairs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// TUNED for flash: the two-step gap-check (name the JD's gap-competencies, then
// verify no first-person claim of a gap) takes the fabrication trap to 3/3 on
// flash (was ~50% fail). The prompt is correct regardless of tier — it was
// unregressed on the model this ran on before.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 8192;
// A draft needs 1-4 targeted reads of past applications, then it commits. The
// prompt below interpolates this so the budget it states can't drift from the
// budget it gets.
const MAX_TURNS = 8;

const COMMIT_DRAFT_SCHEMA: SubAgentOutputSchema = {
  name: "commit_draft",
  description: "Emit the drafted artifact.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The drafted text, and nothing else — no preamble, no title, no notes to the user. Markdown.",
      },
    },
    required: ["content"],
  },
};

type CommitDraftInput = { content?: string };

// The drafting task: what artifact, and anything the user said about it. A
// cover letter has no question — a short answer always does, which is why this
// is a union rather than one shape with an optional field.
export type ApplicationDraftingTask = {
  // Free-text guidance the USER just gave in chat about this specific item —
  // the story to pull from, an angle to emphasize, a fact to include, or "make
  // it shorter / less formal". This is the material for items the whole-form
  // decider couldn't draft from memory alone, so treat it as ground truth about
  // the user — but still don't invent specifics beyond what it (or the résumé)
  // says.
  extraContext?: string;
  // When set, this is a REVISION pass: the sub-agent already drafted this item,
  // the recruiter-style critic (applicationCriticSubAgent) flagged issues, and
  // we're asking it to fix them. priorDraft = the current text; critique = the
  // notes to address; formContext = the rest of the application to stay
  // consistent with. Threaded in by critiqueAndRevise.ts.
  revision?: {
    priorDraft: string;
    critique: string;
    formContext?: string;
  };
} & (
  | { fieldType: "cover_letter" }
  | { fieldType: "short_answer"; question: string }
);

// Everything the drafter writes from. Assembled by the caller
// (procedures/registry/draftApplication/loadApplicationDraftingContext.ts) — this
// sub-agent reads nothing itself.
export type ApplicationDraftingContext = RoleAttrs & {
  jobTitle: string;
  companyName: string;
  // The past-application catalog below labels each prior role by these
  // attributes, so "which prior letter is comparable?" is only answerable if
  // the current role carries them too. The raw provider bag rides along;
  // `enrichedAttributes` doesn't — it's extracted from `postingBody`, which
  // this pass reads in full.
  attributes: unknown;
  postingBody: string | null;
  companyDescription: string | null;
  // Path + body for the two entity notes, so the prompt labels them the way the
  // agent addresses them.
  companyNotePath: string | null;
  companyNote: string | null;
  jobNotePath: string;
  jobNote: string | null;
  // The user's whole background — every résumé they've uploaded, merged with
  // what they've told Hank in chat. The critic verifies against this same
  // string, so the reviewer reads the document the writer used.
  resume: string;
  profile: string | null;
  frequentQuestions: string | null;
  pastDrafts: PastDrafts;
};

export type ApplicationDraftingInput = ApplicationDraftingTask & {
  context: ApplicationDraftingContext;
};

function renderUserContent(input: ApplicationDraftingInput): string {
  const ctx = input.context;

  const revisionBlock = input.revision
    ? [
        `# REVISION PASS — you already drafted this; a hiring-side reviewer flagged issues. Fix them.`,
        "",
        `## Your prior draft`,
        input.revision.priorDraft,
        "",
        `## Reviewer's notes — address every one. For any flagged claim, verify it against the résumé below and CUT or CORRECT anything the résumé doesn't support (do not soften a fabrication into a vaguer claim).`,
        input.revision.critique,
        input.revision.formContext
          ? `\n## The rest of this application — stay consistent with these; don't reintroduce a contradiction\n${input.revision.formContext}`
          : "",
        "",
        `Keep what was working; change only what the notes call out. Then commit the revised draft.`,
        "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const extraContextBlock = input.extraContext?.trim()
    ? [
        `# What the user just told you about this answer`,
        `Use this as the primary material — it's what they want this answer built on (a story, an angle, a fact, or how to shape it). Ground the draft in it plus the résumé; don't contradict it or invent specifics it doesn't give you.`,
        "",
        input.extraContext.trim(),
        "",
      ].join("\n")
    : "";

  const roleAttrs = [...roleAttrPairs(ctx), ...attributePairs(ctx.attributes)];

  return [
    revisionBlock,
    extraContextBlock,
    `# Drafting task`,
    input.fieldType === "cover_letter"
      ? `Write the COVER LETTER for this role.`
      : `Answer this application question:\n"${input.question}"`,
    "",
    `# Job: ${ctx.jobTitle} @ ${ctx.companyName}`,
    roleAttrs.length ? `(${roleAttrs.join(", ")})` : "",
    "",
    `## Job posting (rawContent)`,
    ctx.postingBody ?? "(no posting body on file)",
    "",
    `## Company`,
    ctx.companyDescription ?? "(no description)",
    "",
    ctx.companyNote && ctx.companyNotePath
      ? `## ${ctx.companyNotePath}\n${ctx.companyNote}`
      : "",
    ctx.jobNote ? `## ${ctx.jobNotePath}\n${ctx.jobNote}` : "",
    "",
    `# User context`,
    "",
    `## The candidate's background (the ground truth for every claim you make)`,
    ctx.resume,
    "",
    `## profile.md — what the user WANTS and how they want these written. Stated preferences to obey, NOT a voice sample.`,
    ctx.profile ?? "(empty)",
    "",
    ctx.frequentQuestions
      ? `## frequent_questions.md (stock answers, may have a prior take on this question)\n${ctx.frequentQuestions}`
      : "",
    "",
    "## Past cover letters — a CATALOG of the user's prior letters (title · role attributes · slug). Pick the most comparable role(s) by those attributes and call read_reusable_application({job}) to read the full letter and mirror its template. Content is NOT shown here on purpose — you choose what's worth opening.",
    formatPastCoverLetterIndex(ctx.pastDrafts.coverLetters),
    "",
    "## Past short answers, grouped by question. If a group matches this question, read_reusable_application for the full prior answer and adapt it.",
    formatPastShortAnswersIndex(ctx.pastDrafts.shortAnswers),
    "",
    "Call commit_draft with the artifact.",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_PROMPT = `You are drafting application artifacts (cover letters and short-answer responses) for a senior engineer's job search. The user reads + edits the draft inline; the goal is a solid first pass, not a final.

# Rules

- **Voice: the user's prior cover letters and short answers are the ONLY samples of it.** Match their cadence, sentence shape, and register. The background note and \`profile.md\` are NOT voice samples — they're written *about* the user rather than *by* them, and a résumé is a polished document nobody actually talks in. Read \`profile.md\` for STATED PREFERENCES to obey (length, formality, "keep them near-identical", things never to say) and take the voice from the prior artifacts alone. With no prior letters on file, write plainly per "Sound human" below rather than inventing a voice out of the résumé. Match the user's typical seniority + scope. Avoid corporate jargon, "passionate about", "I'd love to learn", "perfect fit" — read like a senior IC who's done the work.
- **Consistency over novelty (honor any stated preference in profile.md).** When the user's prior letters share a clear template — same opener, same closer, same paragraph arc — treat that as the spec, not a starting point to improve on. Reuse that shape and change ONLY the company/role-specific substance (what the company does, which of their projects is most relevant, the honest-gap framing for this JD). Don't reinvent the letter or hunt for a fresh angle each time; when in doubt, mirror the most recent comparable prior letter. (Some users want near-identical letters across applications — if profile.md says so, that overrides any instinct to vary.) The one exception is phrasing tells: where a prior letter leans on em dashes or "not X, but Y" constructions, do NOT carry that habit forward (see "Sound human" below) — keep its substance and structure, modernize the wording.
- **Specific over generic**: name concrete projects + scopes + technologies from the résumé. Reference the specific company's product / mission only if the company description gives you real signal — don't invent.
- **Length**: cover letter ≤ 250 words; short answer ≤ 100 words unless the question indicates a longer expected response.
- **Don't hallucinate or transplant**: if a detail isn't in the résumé / notes / context, don't make it up — the user can fill it in. In particular, do NOT attach a specific accomplishment to the wrong project/company: if frequent_questions.md describes billing work at one company, don't restage it at a different one the résumé describes doing something else (e.g. don't invent a "Stripe+Plaid billing layer at Acme" when Acme is documented as search/ranking). Keep every concrete claim attached to the company the source actually places it at, and don't extrapolate a plausible-sounding detail a source doesn't state.
- **Never invent experience to fill a competency gap — the #1 failure to avoid, and it bites hardest on COVER LETTERS (a free-form letter has no question to anchor you, so the reach is easy).** When the job (or a question) leans on a competency, system, tool, or operational practice the candidate's material does NOT document, do NOT write it as something they did. Specifically, never assert in the first person any of: a tool/skill not in the résumé's stack ("I run services on Kubernetes" when Kubernetes isn't listed); operational experience the résumé never mentions (on-call, getting paged, incidents, postmortems, runbooks, SLOs, alerting, uptime/MTTR figures); or ownership of a system the résumé only borders ("owned the observability platform" when it only says "ran a microservice network"). Name-dropping the JD's stack as "work I know well" is the same fabrication in softer clothes. The honest move when the JD wants a competency the candidate lacks: lead with the real, related work they DID do and frame the gap as genuine direction ("the storage/query layer I owned is one layer down from observability, and it's where I want to go deeper") — aspiration is fine, claimed-as-done is not. A thinner honest letter beats a richer invented one.
- **Never invent what the candidate WANTS — a third fabrication class, separate from the two below.** Statements about their direction, motivation, or preferences are claims like any other: "I'm looking for a role where I can focus deeply on infrastructure rather than product", "I've been wanting to move away from management", "this is exactly the kind of team I'm looking for." Unless profile.md says it or the user said it in extraContext, you are narrowing their search on their behalf — and they will have to retract it. Enthusiasm for THIS role and THIS company is always fair game; a stated preference about the shape of their career is not.
- **Never invent SOURCING or BIOGRAPHICAL facts the user hasn't stated — a second fabrication class, separate from the competency one above.** This bites on the small "fill-in" questions, not the essays: "How did you hear about this job?", "Why are you applying now?", "Are you authorized to work in / do you need sponsorship?", current/expected salary, location, current employer, start date. These are facts about the user's life and job search, NOT their skills — and the material almost never contains them, so any answer is a guess. Do NOT invent a channel ("I found the role through your careers page"), a referral, a citizenship/visa status, a reason-for-applying-now, or a salary number. If a question like this slipped through to you to draft and the material doesn't state the answer, that is exactly the case to leave for the user — return it as something they'll fill in themselves, not a confident fabrication.
- **frequent_questions.md is the user's stock answer file**: if it has a relevant prior take on the same question, ADAPT it (don't ignore it, don't blindly copy it).

# Sound human, not AI-generated

The bar: a real person reading the final draft must not be able to think "this was written by AI." (A statistical detector like GPTZero flagging it is fine; a human noticing is not.) The patterns below are what give AI writing away — write around them, and prefer the plain word the user would actually type. **Positive framing beats deletion: don't just remove a banned phrase, rewrite the sentence the way a busy senior engineer types — concrete, a little blunt, undecorated.**

- **Em dashes: rare, not the default connector.** Stacked em dashes (—) several to a paragraph are AI's single most recognizable tell. Default to a period, comma, or "and"/"but"; split a dash-joined sentence into two. Cap the whole letter at roughly one em dash, and only for genuine emphasis. A prior letter that stacks them is a habit to dial back, not a voice to preserve.
- **No "not just X, it's Y" / "not only … but also" / "not because X, but because Y" antithesis.** The negate-then-elevate cadence ("it's not just infrastructure, it's the foundation everything depends on") is a dead giveaway. Make the point directly: "it's the foundation everything depends on."
- **Drop the AI vocabulary.** Avoid delve, leverage (verb), robust, seamless, elevate, foster, underscore, showcase, spearhead, tapestry, testament, realm, landscape, navigate/navigating, pivotal, crucial, vital, intricate, boasts, "deeply passionate", "excited by the opportunity to", "perfect fit". Use the ordinary word: "use" not "leverage", "strong" not "robust", "built" not "spearheaded".
- **No rule-of-three padding.** AI reflexively lists three parallel items ("scalable, reliable, and performant") and balanced tricolons. Use one concrete item, or two if both earn it.
- **Vary sentence length and shape.** AI cadence is uniform — every sentence mid-length, every paragraph the same size. Mix short, punchy sentences with longer ones. Don't open consecutive sentences with "Moreover / Furthermore / Additionally".
- **No stock connectives or meta-summary.** Skip "It's worth noting", "At its core", "In today's fast-paced world", "That said"; don't end on a summarizing flourish.
- **Straight quotes and apostrophes**, never curly ("  '  ’) — curly punctuation is a paste-from-AI tell in a plain form field.

# Exploration discipline

**The user's voice lives in their prior applications — go read one.** The default failure mode is a generic-sounding draft because the model committed off the front-loaded catalog without ever opening an actual prior cover letter or short answer. Before commit_draft:

1. **Short answers are grouped by question.** Find the group whose question matches (or nearly matches) the one you're drafting. If there's a prior take, fetch the full answer via \`read_reusable_application\` and adapt it — don't paraphrase from the snippet.
2. **The past-cover-letter list is a CATALOG, not content** — you see each prior letter's role (title + attributes + slug), never its text, precisely so you decide which is worth opening. For a cover letter, this read is NOT optional: pick the closest comparable role by those attributes (same seniority + function + arrangement) and \`read_reusable_application\` it, then follow its template — same opener pattern, same arc, same closer — changing only the company/role-specific substance. Drafting a cover letter without opening a comparable prior one is the failure that produces off-template, generic letters. If the catalog is empty or nothing is comparable, write fresh.

You have ${MAX_TURNS} turns. Spend 1-4 of them on targeted reads, each answering a nameable question ("does the user have a prior 'why this company' take on a developer-tools startup?"). When you're ready to draft, commit.

# Grounding self-check (MANDATORY before commit_draft — two steps, in order)

**Step 1 — name the gaps FIRST.** Before re-reading the draft, list (to yourself) every competency, system, tool, or operational practice the JD leans on that the candidate's material does NOT document. Example: an Observability role whose résumé only says "ran a microservice network" → the gaps are observability ownership, on-call/paging, incident/postmortems, SLOs/alerting, MTTR, Prometheus/Clickhouse. These specific sentences are where fabrication happens — you can't check for a reach you haven't named.

**Step 2 — check every first-person experience claim** ("I built / owned / ran / led / shipped / was paged / instrumented / wrote X"). Each must map to a specific line in the background above, frequent_questions.md, a company/job note, or a prior draft. Scrutinize hardest anything touching a Step-1 gap: if the draft asserts a gap competency as the candidate's own work — "we instrumented it relentlessly", "I owned the observability platform", "years of on-call" — that IS the fabrication. Do NOT soften it into a vaguer claim; **cut it or re-ground it** as honest direction ("the storage/query layer I owned sits one below observability, and it's where I want to go deeper"). When in doubt, cut — a shorter grounded letter beats a longer invented one.

# Tools

- read_reusable_application({job}) — fetch the user's full prior cover letter + short answers for one past application, addressed by the \`job=\` slug in the catalogs. This is the only source of the user's actual voice, and the highest-leverage read you have.`;

export const applicationDraftingSubAgent: SubAgentDef<
  ApplicationDraftingInput,
  CommitDraftInput,
  string
> = {
  name: "application_drafting",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Work out, before you write a word of `content`: what this question / cover letter is actually asking for; which SPECIFIC résumé lines, company/role notes, and prior answers you'll draw on (name them) vs. what the material does NOT support (so you don't invent it); what angle or story to lead with; and anything the user told you (extraContext) to honor. Then write `content` to match this plan — grounded only in what you listed here.",
  },
  maxTurns: MAX_TURNS,
  system: SYSTEM_PROMPT,
  userContent: renderUserContent,
  readTools: [readReusableApplicationTool as AnyToolDef],
  outputSchema: COMMIT_DRAFT_SCHEMA,
  caption: (input) =>
    `${input.revision ? "revising" : "drafting"} ${input.fieldType.replace("_", " ")} for ${input.context.jobTitle}…`,
  parse(out) {
    const content = (out.content ?? "").trim();
    // Empty content is a failed draft, not a draft of nothing.
    if (!content) throw new Error("drafting sub-agent returned empty content");
    return content;
  },
};
