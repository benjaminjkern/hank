// Application critic sub-agent (transform class).
//
// Runs AFTER a job's application answers are drafted (cover letter + short
// answers). Reviews the WHOLE form at once against the job posting and the
// candidate's resume, plus the candidate's OTHER applications to the same
// company, and returns per-item critiques that the caller hands back to
// runApplicationDrafting for a revision pass (see critiqueAndRevise.ts).
//
// The mandate is deliberately a RECRUITER's, not a coach's:
//   - It knows the candidate ONLY through the application + the resume (the two
//     things a real reviewer on the hiring side would have). It gets NO user
//     memory (profile.md, notes) — the "fresh reader" boundary the
//     user asked for is enforced STRUCTURALLY by making this a transform-class
//     sub-agent with no read tools: everything is front-loaded, so it physically
//     cannot reach into memory.
//   - Two things to catch: (1) anything incorrect or contradictory — a claim
//     the resume doesn't support, two answers that disagree, an answer that
//     conflicts with what the candidate told this same company on another
//     application; and (2) quality gaps a stranger would notice — generic
//     filler, not-actually-answering-the-question, wrong-company paste.
//
// It does NOT rewrite — it critiques. The revision is runApplicationDrafting's
// job (it has the full user context to fix things correctly), so the critic
// stays a pure read-only judge.
//
// Reads nothing: the posting, the resume, and the sibling applications are
// assembled by the caller (procedures/registry/draftApplication/
// loadApplicationCriticInput.ts). That's also what makes the "fresh reader" boundary
// checkable — the context object IS the complete list of what this reviewer
// knows about the candidate.
//
// Siblings are applications the candidate has actually SUBMITTED here, which the
// caller establishes from the APPLIED event rather than from draft state — a
// draft nobody sent isn't in the recruiter's file, and an inconsistency against
// one would be a fabricated finding.

import {
  JobCloseReason,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { attributePairs } from "@/server/entities/jobs/attributePairs";
import {
  formatRoleAttrs,
  roleAttrPairs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// UNTUNED on the cheap tier — conservative pin. A single-shot transform judge
// with no self-verification loop; missing a fabrication (or inventing a fake
// contradiction) is costly, and flash's fabrication weakness has bitten exactly
// these self-contained judge tasks (see enrichJob / memoryConsolidation).
// Re-audit before dropping to flash.
const MODEL: LlmModel = "deepseek-v4-pro";
const MAX_TOKENS = 8192;

export type CritiqueSeverity = "blocking" | "polish";
// The named kinds are the failure modes this critic exists to catch; `other` is
// the escape hatch that keeps a real problem outside them from being forced into
// the nearest label (and is where an unrecognized emission lands).
export type CritiqueKind =
  | "contradiction"
  | "unsupported_claim"
  | "cross_application"
  | "jd_mismatch"
  | "redundancy"
  | "quality"
  | "other";

export type CritiqueIssue = {
  // Which drafted item(s) this issue is about, so the caller knows what to
  // re-draft. Each entry is either the literal "cover_letter" or the exact
  // short-answer question text. A cross-answer contradiction lists both.
  targets: string[];
  severity: CritiqueSeverity;
  kind: CritiqueKind;
  // Actionable, specific critique handed to the drafting agent. Internal — the
  // revised draft is what the user sees when a revision lands.
  writerNote: string;
  // The same finding said to the APPLICANT, for the case where no revision
  // resolves it. A revision can only reword what's on the page; half these
  // findings turn on a fact only the person knows ("is that venture still
  // running?"), so the loop giving up has to leave something a human can settle.
  userNote: string;
};

// The whole review. There is no verdict field: "clean" IS an empty issues list,
// so a separate word for it would be a second name for the same fact — and one
// the caller would have to decide whether to trust.
export type ApplicationCritique = {
  issues: CritiqueIssue[];
  // One line to the candidate about the application as a whole, shown to them
  // verbatim in chat. It exists because the alternative is a fixed sentence:
  // the runner has to say SOMETHING when a pass finishes, and only the reader
  // who just went through the writing can say what's actually in it.
  note: string;
};

// One application the candidate has ALREADY SUBMITTED to this same company —
// what a recruiter would find in their own file. Carries the role attributes so
// the critic can weigh how comparable it is, not just what it said.
export type SiblingApplication = RoleAttrs & {
  jobTitle: string;
  // "4d ago" / "2mo ago", off the APPLIED event. Pre-rendered by the caller
  // because reading the clock inside userContent would make it impure.
  appliedAgo: string;
  // What became of it. Rendered into a recruiter's words by `siblingOutcome`
  // below — the critic role-plays reading its own file and never sees an enum.
  status: JobInteractionStatus;
  closeReason: JobCloseReason | null;
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
};

// Everything the reviewer gets to see. There is no other channel — no read
// tools, no memory — so this is the whole world from the critic's side.
export type ApplicationCriticInput = {
  jobTitle: string;
  companyName: string;
  posting: RoleAttrs & {
    // The RAW provider bag only. Level / team / comp-band live here and are what
    // a jd_mismatch verdict turns on. `enrichedAttributes` is deliberately
    // absent: it's extracted from the body, which this reviewer reads in full.
    attributes?: unknown;
    // The posting body, or null when none is on file.
    body: string | null;
    companyDescription: string | null;
  };
  // The current form to review — the caller passes the freshly-drafted /
  // persisted state so the critic reviews exactly what's on file.
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
  resume: string;
  // The candidate's other SUBMITTED applications to this same company.
  siblings: SiblingApplication[];
};

const SEVERITY_VALUES = ["blocking", "polish"] as const;
const KIND_VALUES = [
  "contradiction",
  "unsupported_claim",
  "cross_application",
  "jd_mismatch",
  "redundancy",
  "quality",
  "other",
] as const;

const REPORT_CRITIQUE_SCHEMA: SubAgentOutputSchema = {
  name: "report_critique",
  description:
    "Report your review of the whole application. `issues` gets one entry per distinct problem the analysis surfaced — an empty array IS the clean verdict, so there is nothing else to set. Each issue is stated twice: `writerNote` for the agent that will redraft the item, `userNote` for the candidate, who may read it verbatim. Both are conclusions, never your reasoning. `note` is the one line the candidate reads first.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description:
          "One or two sentences to the CANDIDATE, shown verbatim as the opening line when their application comes up. Say what's actually in this one — what the letter leads on, which answer does the most work, what you'd look at first — the way a colleague who just read it would. It is NOT a verdict word and NOT a summary of `issues` (those are shown separately, in the candidate's own list): don't say 'no issues found' or count anything. Write it about THIS application, so it couldn't be pasted onto another. Plain language — no field names, no severity/kind words, no talk of reviews, passes, or drafting machinery.",
      },
      issues: {
        type: "array",
        description:
          "Fill this AFTER `analysis` — one entry per distinct problem your analysis surfaced. Every contradiction, unsupported claim, overlap, and quality gap you noted in `analysis` gets an entry here; don't let one drop. Leave it empty ONLY when `analysis` concluded 'clean' — an empty array is how you report a clean application.",
        items: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              items: { type: "string" },
              description:
                'Which drafted item(s) this is about: the literal string "cover_letter", or the EXACT question text of a short answer (copy it verbatim from the form above). A contradiction between two answers lists both questions so both get revised.',
            },
            severity: {
              type: "string",
              enum: SEVERITY_VALUES as readonly string[] as string[],
              description:
                "blocking = factually wrong / unsupported by the resume / contradictory / inconsistent with another application to this company — MUST be fixed. polish = accurate but generic, vague, doesn't fully answer the question, or reads as filler.",
            },
            kind: {
              type: "string",
              enum: KIND_VALUES as readonly string[] as string[],
              description:
                "contradiction = two answers (or an answer and the cover letter) disagree on the same fact (e.g. different durations/numbers for the same thing). unsupported_claim = a claim the resume doesn't back. cross_application = disagrees with what the candidate told this same company on another application. jd_mismatch = misreads / doesn't address what the posting asks. redundancy = two artifacts cover the same ground / lead with the same story or metric, reading repetitively when read together. quality = generic, vague, doesn't answer the question, wrong-company paste. other = a real problem none of the above name — use it rather than forcing a bad fit, but prefer a specific kind whenever one applies.",
            },
            writerNote: {
              type: "string",
              description:
                "Specific, actionable critique for the WRITER — another agent that will redraft this item. For a factual issue, name the claim and what the resume actually supports ('The letter says you led a 30-person org; the resume shows a 6-person team — drop or correct'). For quality, say what's missing ('Doesn't actually answer why THIS company — no reference to their product'). State the finding only: no first-person deliberation, no 'let me check', no reversing yourself mid-sentence. If your analysis ended up deciding this is NOT a problem, don't emit the issue at all.",
            },
            userNote: {
              type: "string",
              description:
                "The SAME finding addressed to the CANDIDATE — shown to them verbatim if no revision resolves it, so it must read as a finished sentence from a careful reader, not as your thinking. One or two sentences, second person, naming what you saw and what they'd need to confirm or change: 'Your letter says you're based in New York; the resume gives Los Angeles.' or 'The letter describes Savvy in the past tense, but the resume lists it as current — which is right?'. Plain language: no field names, no severity/kind words, no 'the critic', no scratchpad.",
            },
          },
          required: ["targets", "severity", "kind", "writerNote", "userNote"],
        },
      },
    },
    required: ["note", "issues"],
  },
};

type ReportCritiqueInput = {
  note?: string;
  issues?: Array<{
    targets?: unknown;
    severity?: string;
    kind?: string;
    writerNote?: string;
    userNote?: string;
  }>;
};

function coerceSeverity(v: unknown): CritiqueSeverity {
  return v === "polish" ? "polish" : "blocking";
}
function coerceKind(v: unknown): CritiqueKind {
  return (KIND_VALUES as readonly string[]).includes(v as string)
    ? (v as CritiqueKind)
    : "other";
}

function renderUserContent(input: ApplicationCriticInput): string {
  const coverLetter = input.coverLetter?.trim() || null;
  // An answer with no text can't be critiqued and can't be revised (the loop's
  // resolveTarget refuses it), so showing it only invites a wasted issue.
  const answers = input.shortAnswers.filter((a) => a.answer.trim());
  const manifest = [
    coverLetter ? "a cover letter" : null,
    answers.length
      ? `${answers.length} short answer${answers.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const meta = [
    ...roleAttrPairs(input.posting),
    ...attributePairs(input.posting.attributes),
  ];

  return [
    `# Application to review — ${input.jobTitle} @ ${input.companyName}`,
    "",
    `## The job posting`,
    meta.length ? `(${meta.join(", ")})` : "",
    "",
    input.posting.body ?? "(no posting body on file)",
    "",
    input.posting.companyDescription
      ? `## About the company\n${input.posting.companyDescription}`
      : "",
    "",
    `# What the candidate submitted (this is what you, the reviewer, are reading)`,
    `This application has ${manifest} — those are the only items you can flag.`,
    "",
    coverLetter ? `## Cover letter\n${coverLetter}` : "",
    answers.length
      ? `## Short answers\n${answers
          .map((a, i) => `### Q${i + 1}: ${a.question}\n${a.answer.trim()}`)
          .join("\n\n")}`
      : "",
    "",
    `# Ground truth: the candidate's resume`,
    "(Use this to check every factual claim in the application. A claim the resume doesn't support is a fabrication to flag.)",
    "",
    // The same background the drafter wrote from, so the reviewer verifies
    // against the document the writer used — byte-identical, not a variant.
    input.resume,
    "",
    `# The candidate's OTHER applications to this same company`,
    "(You, the recruiter, can see these too — the role they applied for, when they applied, and what came of it. Flag anything the current application says that CONTRADICTS what they told you on another role — different years of experience, a conflicting story, a cover letter that still names a different company or role. An outcome is BACKGROUND ONLY: that you passed on an earlier application is never evidence that THIS one is weak — judge this one on what's on the page.)",
    "",
    renderSiblings(input.siblings),
    "",
    "Review the whole application now and call report_critique.",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSiblings(siblings: SiblingApplication[]): string {
  if (!siblings.length) {
    return "(no other applications to this company on file — nothing to cross-check against.)";
  }
  const parts: string[] = [];
  for (const s of siblings) {
    const attrs = formatRoleAttrs(s);
    parts.push(
      `## ${s.jobTitle}${attrs ? ` · ${attrs}` : ""}\napplied ${s.appliedAgo} · ${siblingOutcome(s)}`,
    );
    if (s.coverLetter) parts.push(`### Cover letter\n${s.coverLetter}`);
    if (s.shortAnswers.length) {
      parts.push(
        "### Short answers\n" +
          s.shortAnswers
            .map((a) => `**Q:** ${a.question}\n**A:** ${a.answer}`)
            .join("\n\n"),
      );
    }
    // Applying wipes the drafts the user never touched, so a sibling can be on
    // file with nothing left to read. Say so, or its bare heading reads as an
    // application with empty answers.
    if (!s.coverLetter && !s.shortAnswers.length) {
      parts.push(
        "(nothing on file from this one — you know they applied, not what they wrote.)",
      );
    }
  }
  return parts.join("\n\n");
}

// What became of a sibling application, in the reviewer's own voice — the critic
// is role-playing a recruiter reading their own file, so it never sees a status
// enum.
function siblingOutcome(s: SiblingApplication): string {
  switch (s.status) {
    case JobInteractionStatus.REJECTED:
      return "we passed on them for this one";
    case JobInteractionStatus.OFFERED:
      return "we made them an offer";
    case JobInteractionStatus.RESPONDED:
    case JobInteractionStatus.INTERVIEW_SCHEDULED:
    case JobInteractionStatus.INTERVIEW_DEBRIEF:
      return "in process with us";
    case JobInteractionStatus.WAITING_ON_RESPONSE:
      return "waiting on us to get back to them";
    case JobInteractionStatus.CLOSED:
      return s.closeReason === JobCloseReason.WITHDRAWN
        ? "they withdrew"
        : "no longer in play";
    case JobInteractionStatus.DELISTED:
      return "the posting came down";
    default:
      return "no decision from us yet";
  }
}

const SYSTEM_PROMPT = `You are a hiring-side reviewer (recruiter / hiring manager) reading a candidate's job application. You know this candidate ONLY through what's in front of you: their application (cover letter + short answers), their resume, and their other applications to your company. You have no other context about them — judge exactly as a real reviewer would, from the page.

Your job: catch problems BEFORE this application goes out, and report them so the writer can fix them. Two things to look for.

# Do the whole review before you list anything
The review happens in \`analysis\` (see its field description on \`report_critique\`), and it has to happen there in full — you cannot reliably catch a cross-artifact contradiction by jumping straight to listing issues, because you'd commit to your first issue before you've read the second artifact against the first.

# 1. Anything incorrect or contradictory (these are BLOCKING)

- **Unsupported claims.** Every concrete claim in the cover letter and answers must be backed by the resume: a specific system owned, a technology used, a scale/metric, a title, years, a company. If the application asserts something the resume doesn't show — "I led a 30-person org", "years of on-call", "owned the observability platform", a tool not in their stack — flag it. Name the claim and what the resume actually supports.
- **Internal contradictions — cross-check the artifacts against EACH OTHER.** When the SAME fact appears in two places and the two versions disagree, that's a contradiction — a recruiter reading both back-to-back WILL notice. The most common and most damaging form is a **number or duration stated two ways**: the cover letter says "the last year and a half at Acme" while a short answer says "the last two years at Acme"; one answer says a 6-person team, another says 10. Go fact by fact: for every duration, headcount, metric, or title that shows up in more than one artifact, confirm the two match. If they don't, flag it and list BOTH items in \`targets\` so both get fixed. Also catch narrative disagreements — a claim in one place undercut by another.
- **Cross-application inconsistency.** Compare against their OTHER applications to this same company. If they told you 8 years on one role and 5 here, or a cover letter still opens with a different company's name or a different role title (a stale paste), flag it — a recruiter comparing two of the same candidate's applications WILL notice. Each sibling shows the role's attributes and what became of it: attributes tell you how comparable the two roles are, and the outcome is BACKGROUND ONLY — an earlier rejection is never itself evidence that this application is weak, and "they got passed over before" is not an issue. Only a genuine conflict between what the two applications SAY is.

Do not invent problems. A claim the resume plainly supports is not an issue. When you're unsure whether the resume supports a claim, lean toward flagging it as an unsupported_claim so the writer can verify — the writer has the full context to confirm or correct.

# 2. Quality and repetition, judged as a stranger reading the whole packet

You know nothing about this person beyond the page, so judge whether the application STANDS ON ITS OWN — and remember the reviewer reads the cover letter AND the answers together, in one sitting:

- **Overlap / redundancy across artifacts (kind: redundancy, usually POLISH).** Flag this ONLY when repeating the same story WASTES the second artifact — its question wanted a different angle and the restatement crowds that out. The clearest case: a "Why are you interested in [company]?" answer that OPENS by re-narrating the candidate's own project and headline metric (the same job, the same system, the same "1M+ users" number already in the cover letter) instead of talking about the company — the answer's job was the company, and the repeat displaces it. Flag it, list both items in \`targets\`, and say what the second one should lead with instead (the company-specific reason, a different angle). **Do NOT flag overlap the question itself invites:** if a short answer asks "describe a system you built / are proud of," naming the same flagship project the cover letter mentioned is the appropriate, honest answer — not redundancy. The test is "does the repeat cost the second artifact the thing its question actually asked for?", not "do the two artifacts mention the same project anywhere."
- **Does it actually answer the question?** A "Why this company?" that never mentions anything specific to the company, a "describe a hard problem" that stays abstract — flag it. If it flat-out doesn't answer, that's blocking.
- **Generic / filler.** Corporate boilerplate, "passionate about", buzzwords, rule-of-three padding, sentences that could be on anyone's application. Say what's missing (a concrete project, a real reason).
- **Wrong-company or wrong-role paste.** An answer that references the wrong company, product, or role.

# How to report

- One \`issues\` entry per distinct problem. Set \`targets\` to the exact item(s): the literal \`"cover_letter"\` or the EXACT question text (copy it verbatim). A cross-artifact contradiction or an overlap lists BOTH.
- **Every issue is written twice, for two different readers.** \`writerNote\` is for the WRITER — the agent that will redraft the item: direct, specific, name the exact claim/sentence and the fix. \`userNote\` is the same finding for the CANDIDATE, and they may read it word for word: a finished sentence in plain second person, naming what you saw and what they'd need to confirm. Many of your best findings can only be settled by the person — whether a venture is still running, where they actually live, whether they really did tune that system — and a redraft cannot answer those. That is what \`userNote\` is for.
- **Both notes state a conclusion; neither shows your work.** Your deliberation belongs in \`analysis\` and stays there. Never emit a note that argues with itself, checks something mid-sentence, or reverses course ("Actually, the resume does say 'engineering team of 5' — so this is fine. Let me re-check."). If that is where your reasoning landed, the issue is not real: drop it and don't list it.
- If the whole application is accurate, self-consistent, non-repetitive, and answers each question well, return an empty \`issues\` array — that IS the clean verdict. Don't manufacture polish notes to look thorough — a clean application is a valid, common result.`;

export const applicationCriticSubAgent: SubAgentDef<
  ApplicationCriticInput,
  ReportCritiqueInput,
  ApplicationCritique
> = {
  name: "application_critic",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Do the WHOLE review here, then distill it into `issues`. Work in this exact order:\n(1) List every CONCRETE claim in the cover letter — duration/years, titles, team sizes, scale/metrics, systems owned, tools, companies.\n(2) Do the same for EACH short answer.\n(3) CROSS-CHECK the artifacts against EACH OTHER. For any fact that appears in more than one place — ESPECIALLY a duration or number ('a year and a half' vs 'two years' at the same company, a headcount, a metric) — do the two statements AGREE? The same fact stated two different ways is a CONTRADICTION (list every artifact it appears in as targets). This cross-artifact pass is the one most often missed — do it explicitly, number by number.\n(4) CROSS-CHECK every claim against the resume — is it supported? An unsupported claim is blocking.\n(5) OVERLAP: does an artifact re-narrate a story/metric another already told in a way that WASTES it — the clearest case being a 'Why [company]?' answer that OPENS with the candidate's own project + headline number (the same one in the cover letter) instead of talking about the company? That's `redundancy`. But do NOT flag overlap the question itself invited: a 'describe a system you built / are proud of' answer naming the same flagship project the cover letter mentioned is the honest answer, not redundancy. The test is 'does the repeat cost the second artifact what its question actually asked for?' — not 'do both mention the same project anywhere'.\n(6) Per-item quality: does each answer actually answer ITS question, or is it generic filler?\nEnd with one line: 'Conclusion: clean' or 'Conclusion: N issues'. Every problem you name here becomes an `issues` entry — don't let one drop, and don't add one you didn't name here. A candidate you talked yourself OUT of here is not an issue: it does not get an entry, and its wording never leaks into one. All of the checking, doubting, and reversing happens in this field and stops at its edge — `writerNote` and `userNote` each state a settled conclusion.",
  },
  system: SYSTEM_PROMPT,
  userContent: renderUserContent,
  outputSchema: REPORT_CRITIQUE_SCHEMA,
  caption: (input) => `reviewing the application for ${input.jobTitle}…`,
  parse(out) {
    const rawIssues = Array.isArray(out.issues) ? out.issues : [];
    const issues: CritiqueIssue[] = [];
    for (const raw of rawIssues) {
      const targets = Array.isArray(raw?.targets)
        ? raw.targets
            .filter((t): t is string => typeof t === "string" && !!t.trim())
            .map((t) => t.trim())
        : [];
      const writerNote =
        typeof raw?.writerNote === "string" ? raw.writerNote.trim() : "";
      const userNote =
        typeof raw?.userNote === "string" ? raw.userNote.trim() : "";
      if (!targets.length || !writerNote) continue;
      issues.push({
        targets,
        severity: coerceSeverity(raw.severity),
        kind: coerceKind(raw.kind),
        writerNote,
        // A missing userNote can't be invented here, and showing the writer's
        // instruction to the applicant reads as a stray directive — so an issue
        // without one is revised silently and never surfaced.
        userNote,
      });
    }

    return {
      issues,
      note: typeof out.note === "string" ? out.note.trim() : "",
    };
  },
};
