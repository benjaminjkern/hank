// Application decider sub-agent (transform class).
//
// Runs ONCE per job, sees the whole application form at once, and emits a
// per-item verdict — `draft` / `skip` / `ask_user` — for every form question
// and (when the form wants one) the cover letter. This is the authoritative
// draft-vs-skip-vs-ask call:
//
//   draft    → enough material exists (resume / company+job notes / a relevant
//              PRIOR answer to adapt) to auto-write a strong, specific answer.
//              The walkthrough then calls runApplicationDrafting for these.
//   skip     → stock / identity / copy-paste field (LinkedIn, GitHub, work-auth
//              yes/no, pronouns) or a structured widget (select / checkbox /
//              file). The user fills these in; no LLM draft.
//   ask_user → a genuine prose question (or the cover letter) that needs
//              personal specifics Hank doesn't have, with no relevant prior
//              answer to adapt. The walkthrough hands off to chat co-writing.
//
// Reuse-aware at the level of EXISTENCE only: it sees which questions the user
// already has a reusable answer for and which roles have a prior cover letter —
// never the text of either. A prior answer to the same question is enough to
// turn an ask_user into a draft; how much of that text is worth reusing is
// applicationDraftingSubAgent's call, and it holds both the bodies and the
// deep-read tool to make it. That split is what keeps this a ONE-SHOT: every
// note that could move a verdict is front-loaded by the caller, so there is
// nothing left for it to read.
//
// The one thing decided before this runs is structural: a dropdown / checkbox /
// rating has no prose answer by construction, so the caller pre-skips it by
// widget TYPE. Everything else is this sub-agent's call from the question text —
// nothing pre-classifies a question by matching its wording.
//
// The prompt shows the WHOLE form in order, pre-skipped fields included, with
// only the decidable ones numbered. A conditional stub ("If yes, please explain")
// means nothing alone; its anchor is the field printed directly above it, which
// is usually one of the pre-skipped selects. Rendering the form in order is what
// makes that readable — for every question, not just ones a pattern caught.
// Verdicts are positional (one per numbered question, in order) to avoid the
// model copying question text back — same robustness pattern as runPreScan's
// verdicts array.

import { attributePairs } from "@/server/entities/jobs/attributePairs";
import {
  formatAnsweredQuestionIndex,
  formatPastCoverLetterIndex,
  matchPriorAnswersToForm,
  type PastDrafts,
} from "@/server/entities/jobs/pastDrafts";
import {
  roleAttrPairs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { LlmModel } from "@/server/platform/llm/models";
import {
  isProseQuestion,
  type ApplicationQuestion,
} from "@/server/scrape/types";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";
import { USER_FACING_VOICE } from "@/server/subagents/lib/voice";

// flash 5/0/0 on re-run (the batch's one warn was variance). The decision is
// grounded in the form's own questions + the catalog of past applications, so
// there's little room to invent.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 8192;

export type DraftVerdict = "draft" | "skip" | "ask_user";

export type QuestionDecision = {
  question: string;
  verdict: DraftVerdict;
  reason: string;
};

export type ApplicationDecision = {
  questions: QuestionDecision[];
  // null when the form has no cover-letter field.
  coverLetter: CoverLetterDecision | null;
  // A one-sentence heads-up the runner surfaces in chat when the decider chose
  // to HELP anyway despite a soft hold the user expressed in memory (e.g.
  // "hold off on cover letters until I trust the flow"). Hank's default is to
  // help the user apply — a soft/temporary hold is surfaced, not silently
  // obeyed: "I saw you wanted to hold off on X, but drafted it so you can judge
  // it — say the word and I'll drop it." null when nothing to surface.
  notice: string | null;
  decidedAt: string;
};

export type CoverLetterDecision = { verdict: DraftVerdict; reason: string };

export type ApplicationDeciderOutput = {
  // One verdict per `draftable` question, in the order they were passed. The
  // caller merges these with its own deterministic pre-skips.
  questions: QuestionDecision[];
  // null when the form has no cover-letter field.
  coverLetter: CoverLetterDecision | null;
  notice: string | null;
};

// Everything the decider weighs. The caller
// (procedures/registry/draftApplication/decideApplicationForm.ts) loads the job,
// partitions the form, and gathers the user context — this sub-agent reads
// nothing itself.
export type ApplicationDeciderInput = RoleAttrs & {
  jobTitle: string;
  companyName: string;
  // The raw provider bag. `enrichedAttributes` is deliberately absent — it's
  // extracted from `postingBody`, which this pass reads in full.
  attributes: unknown;
  postingBody: string | null;
  companyDescription: string | null;
  // Path + body for the two entity notes, so the prompt labels them the way the
  // agent addresses them.
  companyNotePath: string | null;
  companyNote: string | null;
  jobNotePath: string;
  jobNote: string | null;
  resume: string;
  profile: string | null;
  frequentQuestions: string | null;
  pastDrafts: PastDrafts;
  // The questions this pass decides, in order — the verdicts come back
  // positionally against this list. Must be a subsequence of `allQuestions`
  // holding the SAME objects (build it by filtering that array): the prompt
  // renders one interleaved list and finds these by identity.
  draftable: ApplicationQuestion[];
  // The FULL ordered form, including the fields the caller pre-skipped. A
  // conditional stub ("If yes, please explain") is only interpretable next to the
  // question above it, which is often one of those pre-skipped fields.
  allQuestions: ApplicationQuestion[];
  formWantsCoverLetter: boolean;
};

const VERDICT_VALUES = ["draft", "skip", "ask_user"] as const;

const COMMIT_DECISION_SCHEMA: SubAgentOutputSchema = {
  name: "commit_decision",
  description:
    "Emit one verdict per numbered question (1..N from the list above), in order, as `questions`. `questions` MUST have exactly N entries. If the form has a cover-letter field, also set `coverLetter`. Each `reason` is one short plain-English sentence the user will read — no field-type names, enum values, or jargon.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "One entry per numbered question, in order. Length MUST equal the question count shown.",
        items: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description:
                "Write this FIRST, before `verdict` — the verdict must follow from it. One short plain-English sentence. For ask_user, what you need from them ('No prior answer about a conflict you've navigated'). For draft, what you'll draw on ('Adapting your prior \"why this company\" answer'). For skip, why ('You'll paste your own LinkedIn URL').",
            },
            verdict: {
              type: "string",
              enum: VERDICT_VALUES as readonly string[] as string[],
              description:
                "Set AFTER `reason`, matching it. draft = enough material to auto-write a strong answer (incl. adapting a relevant prior answer). skip = stock/identity/copy-paste/structured field the user fills in. ask_user = genuine prose needing the user's own specifics with no relevant prior answer.",
            },
          },
          required: ["reason", "verdict"],
        },
      },
      coverLetter: {
        type: "object",
        description:
          "Only when the form has a cover-letter field. One-sentence plain-English reason FIRST, then verdict.",
        properties: {
          reason: { type: "string" },
          verdict: {
            type: "string",
            enum: VERDICT_VALUES as readonly string[] as string[],
          },
        },
        required: ["reason", "verdict"],
      },
      notice: {
        type: "string",
        description: `Set ONLY when you chose to help (draft / co-write) despite a SOFT hold the user expressed in memory — e.g. profile.md says 'hold off on cover letters until I trust the flow' or 'I usually skip cover letters'. One plain-English sentence the user reads, telling them you saw the note and went ahead so they can judge it and tell you to stop. ${USER_FACING_VOICE}  (e.g. \"You'd noted holding off on cover letters until you trust this — I drafted one anyway so you can judge it; say the word and I'll drop it."). Omit when no such note applied.`,
      },
    },
    required: ["questions"],
  },
};

type CommitDecisionInput = {
  questions?: Array<{ verdict?: string; reason?: string }>;
  coverLetter?: { verdict?: string; reason?: string };
  notice?: string;
};

function coerceVerdict(v: unknown): DraftVerdict | null {
  return v === "draft" || v === "skip" || v === "ask_user" ? v : null;
}

// Per-question fallback when the model under-fills the verdicts array or emits
// an invalid value, so a malformed emission degrades instead of hard-failing.
// Widget type is the only thing left to go on at that point: a long-text field
// drafts, anything else skips.
function fallbackVerdict(q: ApplicationQuestion): DraftVerdict {
  return isProseQuestion(q.type) ? "draft" : "skip";
}

function renderUserContent(input: ApplicationDeciderInput): string {
  const { draftable, allQuestions, pastDrafts } = input;

  // Map each draftable form question to any prior short answers that answer the
  // same (or a near-identical) question — a repeat question should be drafted
  // (adapt the prior answer), not re-asked. Surfaced inline on the question so
  // the model doesn't have to rediscover the match in the grouped index below.
  const priorByQuestion = matchPriorAnswersToForm(
    draftable.map((q) => q.question),
    pastDrafts.shortAnswers,
  );

  // The whole form in the order the user meets it, with only the fields this
  // pass decides numbered. `draftable` is a filter of `allQuestions`, so the
  // entries are the same objects and membership is an identity lookup.
  const numberFor = new Map(draftable.map((q, idx) => [q, idx + 1]));
  const formListing = allQuestions
    .map((q) => {
      const number = numberFor.get(q);
      const meta = [
        q.required ? "required" : null,
        q.type ? `type=${q.type}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      // A prior answer to this exact question is a strong draft signal — flag it
      // inline with the ids so the model can confirm the match and adapt it.
      const priors = number ? (priorByQuestion.get(q.question) ?? []) : [];
      const priorNote = priors.length
        ? ` — you have ${priors.length} prior answer${priors.length > 1 ? "s" : ""} to this same question (${priors
            .slice(0, 3)
            .map((p) => `job=${p.jobSlug} @ ${p.companyName}`)
            .join("; ")}); adapting one is a draft, not ask_user.`
        : "";
      return `${number ? `[${number}]` : "[-]"} "${q.question}"${meta ? ` (${meta})` : ""}${priorNote}`;
    })
    .join("\n");

  // The same attributes the past-draft catalogs label each prior role by, so
  // "is that prior role comparable?" is answerable.
  const roleAttrs = [
    ...roleAttrPairs(input),
    ...attributePairs(input.attributes),
  ];

  return [
    `# Decide: which application items can Hank draft, which to skip, which need the user's input?`,
    `Job: ${input.jobTitle} @ ${input.companyName}`,
    roleAttrs.length ? `(${roleAttrs.join(", ")})` : "",
    "",
    `## Job posting (rawContent)`,
    input.postingBody ?? "(no posting body on file)",
    "",
    `## Company`,
    input.companyDescription ?? "(no description)",
    "",
    input.companyNote && input.companyNotePath
      ? `## ${input.companyNotePath}\n${input.companyNote}`
      : "",
    input.jobNote ? `## ${input.jobNotePath}\n${input.jobNote}` : "",
    "",
    `# User context`,
    "",
    `## The candidate's background`,
    input.resume,
    "",
    `## profile.md (thesis, constraints, voice, patterns)`,
    input.profile ?? "(empty)",
    "",
    input.frequentQuestions
      ? `## frequent_questions.md (stock answers — a match here means draft, not ask_user)\n${input.frequentQuestions}`
      : "",
    "",
    "## Past cover letters — a catalog of prior letters (title · role attributes · slug). A comparable role here means the cover letter is draft, not ask_user; the writer reads the letter itself.",
    formatPastCoverLetterIndex(pastDrafts.coverLetters),
    "",
    "## Questions the user already has a reusable answer for. A prior take on the same — or a near-identical — question means draft, not ask_user; the writer reads the answer itself and decides how much of it to reuse. Text-identical matches are already flagged inline on the form below, so scan this list for the ones worded differently.",
    formatAnsweredQuestionIndex(pastDrafts.shortAnswers),
    "",
    `# Application form — every field, in the order the user meets them`,
    draftable.length
      ? `Fields marked [1]…[${draftable.length}] are YOURS to decide — emit exactly ${draftable.length} verdicts, in that order. Fields marked [-] are not: either a structured widget (dropdown, checkbox, rating) the user just fills in, already skipped, or the cover letter, which you decide via \`coverLetter\` instead. They're printed so you can read every question in context — a conditional stub like "If yes, please explain" means nothing except next to the field above it.\n${formListing}`
      : allQuestions.length
        ? `No field here needs your judgement — they're all structured widgets the user fills in. Printed for context:\n${formListing}`
        : "(no form questions on file)",
    input.formWantsCoverLetter
      ? "\n## Cover letter\nThis form has a cover-letter field — also emit a `coverLetter` verdict."
      : "",
    "",
    "Call commit_decision — decide draft/skip/ask_user from exactly the context above.",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_PROMPT = `You triage one job's application form for a senior engineer. For each form question — and the cover letter, if the form has one — decide ONE verdict: \`draft\`, \`skip\`, or \`ask_user\`. Return them via commit_decision.

# You are here to HELP the user apply

Your default is to help the user get this application done. A **soft or temporary hold** in their memory — "hold off on cover letters until I trust the flow", "I'm not sure I trust the short-answer drafting yet", "I usually skip cover letters" — is NOT a reason to silently skip or refuse. The user can't react to a decision they never saw. So: **still help** (draft if you have material, ask_user/co-write if you don't), and set the top-level \`notice\` to one plain-English sentence telling them you saw the note and went ahead so they can judge the result and tell you to stop. Surfacing-and-helping beats silently-withholding every time. (Only an explicit, unambiguous standing instruction — "never draft cover letters, period" — is a genuine \`skip\`; a "still testing / holding off for now" note is not. When unsure, help + notice.) Do NOT set \`notice\` when no such hold exists.

# Verdicts

- **draft** — Hank can write a strong, specific first pass right now from material that **DIRECTLY supports the specific thing this question asks**: the resume, the company/job notes, the search thesis, and especially a RELEVANT PRIOR ANSWER in the past-drafts indexes. The bar is *direct evidence, not adjacency*. "Ran a microservice network at scale" does NOT establish "owned an Observability system with alerting / on-call / runbooks"; "founder/CTO" does NOT establish a specific incident-response story. If a question demands a competency, system, achievement, or story the material only *implies* or makes *plausible*, that is **ask_user**, not draft — because drafting forces the writer to invent the specifics (tools, metrics, practices, names) the source never stated, which is worse than asking. Use draft only when the material genuinely contains the substance ("Why do you want to work here?" with real company notes + a prior "why this company" answer; "describe your backend experience" when the resume spells it out).
- **skip** — the user fills this in themselves (or just confirms it); no LLM draft adds value. Identity / contact / logistics / copy-paste fields (name, pronouns, LinkedIn / GitHub / portfolio URL, "how did you hear about us", **current/most recent company or job title**, **years of experience**, work-authorization yes/no, salary / desired comp, start date / notice period, location) AND — importantly — **acknowledgments / attestations / consent / legal-agreement / "confirm you've read this" blocks, even when they're long paragraphs of text**: a "How we interview… please adhere to these expectations" notice, an e-signature certification, an arbitration agreement, an AI-use acknowledgment. None of these have a prose answer worth writing — the user just fills or accepts them. (Dropdowns / checkboxes / multi-selects are already skipped for you — they appear marked \`[-]\` for context only. The stock factual fields listed here are NOT pre-removed: any that reached your numbered list is yours to skip. **File uploads aren't pre-skipped either** — judge them per the file-upload rule below.)
- **ask_user** — a genuine prose question (or cover letter) that needs the user's OWN specifics — a story, an opinion, a motivation — that you do NOT have and CANNOT responsibly invent, AND there's no relevant prior answer to adapt. Examples: "Describe a time you navigated a cross-functional conflict", "What's a technical decision you regret?", an open "Why this company?" when the company notes are thin and there's no comparable prior answer. ask_user means Hank will work it out with the user in chat.

# Calibration

- **A relevant prior answer outranks ask_user.** A form question with a prior answer is flagged inline ("you have N prior answers to this same question…"); those questions are **draft** (Hank adapts the prior), not ask_user. For anything not pre-flagged, still scan the answered-question list for one that means the same thing in different words, and the cover-letter catalog for a comparable role, before calling ask_user — either is **draft**. You are judging that a usable prior EXISTS, not how good it is: the writer sees the actual text and decides how much of it to keep. Re-asking the user something they've effectively already answered elsewhere is the main failure to avoid.
- **Don't ask_user for things the resume already covers.** "Describe your backend experience" is a draft when the resume has it.
- **Don't draft from nothing.** If a prose question needs a specific personal story or stance with no source, that's ask_user — drafting a generic or invented answer is worse than asking.
- **Drafting must SAVE the user real effort — having the material isn't enough.** A short factual field the user types in seconds (current/most recent company, current job title, years of experience, desired salary, "how did you hear") is skip EVEN WHEN the resume technically contains the answer: an LLM "draft" of a one-line fact adds nothing and just clutters the flow. The draft bar is "a written first pass genuinely saves the user effort," not "the answer is derivable." These reach you as ordinary numbered questions — nothing filters them out first, so apply this test to every one.
- **Ground every reason in what's shown — never invent.** Two specific failures to avoid: (1) don't claim a prior answer exists ("adapting a near-identical prior application") unless it's actually in the catalogs above; if there's no prior, say what you ARE drawing on (resume, company notes) or that you'll write it fresh. Keep the reason to the fact that a prior exists — you haven't read it, so don't characterize what it says. (2) Don't assert facts about the user that aren't in the material — no "US citizen", no location, no employer the resume doesn't state. A skip reason can be generic ("You'll answer this one yourself") rather than inventing a justifying fact.
- **A contextless stub is only meaningful next to the field above it.** A bare "Please provide details" / "Other" / "If yes, please explain" is the follow-up to whatever field precedes it on the form — usually a yes/no or a dropdown, printed as \`[-]\`. Read the pair together and decide on that basis: if the anchor is something only the user can answer, the stub is **ask_user**; if the anchor is itself a stock fact, the stub is **skip**. When even the anchor leaves the intent unclear, **skip** — drafting an answer to a question with no standalone meaning just invents one (the user fills it in against the option they actually picked). ("Additional information" / "anything else you'd like us to know" is NOT this — see below; it's a real open-ended prompt.)
- **The widget type is a clue, not the answer — the question text decides.** A \`textarea\` is usually prose but not always: "How did you hear about us?" or "Name of your current company" in a textarea is still a fill-in fact → **skip**. A single-line \`text\` is usually a fact but not always: "Why are you interested in this role?" is prose however it's rendered. Read what the question actually asks, then pick.
- **File-upload questions are yours to judge.** A file field for a document the user simply attaches — resume / CV / transcript / ID / portfolio PDF — is **skip** (nothing to write; they upload their own file). A file field that wants prose the user must compose — a writing sample, personal statement, essay — is **draft** if the material directly supports it, else **ask_user**. (A "Cover Letter" field is routed to the cover-letter track — it shows up marked \`[-]\` and you decide it via \`coverLetter\`, not as a numbered question.)
- **"Additional information" / "additional attachments" / "additional files" / "anything else you'd like us to know" fields are cover-letter-equivalent — DRAFT them.** This open-ended catch-all (whether it's a text box OR a file-upload) is the user's chance to make their case, so treat it exactly like a short cover letter: **draft** a strong, specific pitch from the resume + company/role notes (use ask_user only if you genuinely lack the material to say anything substantive). Draft it **EVEN WHEN it's optional** — an optional free-form field that could help the application is worth filling, not skipping. The ONE exception: if this same form ALSO has a dedicated cover-letter field/slot (the cover letter already carries the pitch), then this catch-all can be **skip** to avoid duplicating it. Never skip an additional-info/attachments field just because it's a file-upload or marked optional.
- **Adjacent ≠ supported (the big one).** When in doubt between draft and ask_user on a question that names a specific experience/system/competency, ask whether you could write the *concrete particulars* (what system, what numbers, what tools, what happened) from the material alone. If you'd have to invent any of them, it's **ask_user**.
- **Cover letter:** draft when a relevant prior cover letter or strong company/role material exists; ask_user when the user clearly needs to shape it themselves with you. A soft "holding off on cover letters until I trust the flow" note is NOT a skip — help anyway (draft or ask_user) and set \`notice\` (see the help-first section). Reserve skip for an explicit, standing "I never write cover letters."

# Language

Every \`reason\` is one short sentence the USER reads in chat. Plain English. Never use the words draft/skip/ask_user, field-type names, enum values, memory paths, or tool names. Say "You'll paste your own GitHub link", not "skip: stock url field".`;

export const applicationDeciderSubAgent: SubAgentDef<
  ApplicationDeciderInput,
  CommitDecisionInput,
  ApplicationDeciderOutput
> = {
  name: "application_decider",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Walk the form: for each question note what it's really asking, what material you have that DIRECTLY supports it (a specific résumé line, a company note, a flagged prior answer) vs. only makes it plausible, and land on draft / skip / ask_user with the reason. Do the cover letter too. Then fill `questions` (and `coverLetter`) to match exactly what you concluded here.",
  },
  system: SYSTEM_PROMPT,
  userContent: renderUserContent,
  outputSchema: COMMIT_DECISION_SCHEMA,
  caption: (input) => `deciding what to draft for ${input.jobTitle}…`,
  parse(out, input) {
    // Map positional verdicts back to the draftable questions. Under-filled /
    // invalid positions fall back to the deterministic isProseQuestion rule so a
    // malformed output degrades to Branch-1 behavior instead of corrupting the
    // decision.
    const rawVerdicts = Array.isArray(out.questions) ? out.questions : [];
    const questions: QuestionDecision[] = input.draftable.map((q, idx) => {
      const raw = rawVerdicts[idx];
      const verdict = coerceVerdict(raw?.verdict) ?? fallbackVerdict(q);
      const reason =
        typeof raw?.reason === "string" && raw.reason.trim()
          ? raw.reason.trim()
          : "";
      return { question: q.question, verdict, reason };
    });

    let coverLetter: CoverLetterDecision | null = null;
    if (input.formWantsCoverLetter) {
      const cl = out.coverLetter;
      coverLetter = {
        verdict: coerceVerdict(cl?.verdict) ?? "ask_user",
        reason:
          typeof cl?.reason === "string" && cl.reason.trim()
            ? cl.reason.trim()
            : "",
      };
    }

    const notice =
      typeof out.notice === "string" && out.notice.trim()
        ? out.notice.trim()
        : null;

    return { questions, coverLetter, notice };
  },
};
