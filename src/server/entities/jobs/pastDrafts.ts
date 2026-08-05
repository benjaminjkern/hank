// The user's PAST application drafts — the read model behind the
// `read_reusable_application` tool.
//
// Two shapes, for two moments. The INDEXES (formatPastCoverLetterIndex /
// formatPastShortAnswersIndex) are catalogs: role attributes + a snippet, no
// bodies, so a sub-agent can see what exists and choose what's worth opening.
// `loadReusableApplication` is the deep read that follows, returning one past
// application's reusable artifacts in full. Keeping bodies out of the
// front-load is deliberate — it's what makes the catalog cheap enough to
// always include.
//
// Lived in subagents/registry/applicationDrafting.ts, which meant two other
// sub-agents imported a DB query out of a third sub-agent.

import { prisma } from "@/server/db/prisma";
import {
  ROLE_ATTR_SELECT,
  formatRoleAttrs,
  toRoleAttrs,
  type RoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { indent, normalizeForCompare, truncate } from "@/utils/text";

const PAST_COVER_LETTER_LIMIT = 30;
const PAST_SHORT_ANSWER_LIMIT = 60;
const COVER_LETTER_SNIPPET_CHARS = 200;
const SHORT_ANSWER_SNIPPET_CHARS = 200;

// One past application's REUSABLE artifacts. Only what the user marked reusable
// comes back — feeding an agent its own non-reusable prior drafts would have it
// match its own voice and recycle unvalidated content. Same rule as the
// indexes above, which is what makes the pair coherent: the index advertises
// what exists, this returns the body.
export type ReusableApplication = {
  jobTitle: string;
  companyName: string;
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
};

export async function loadReusableApplication(
  userId: string,
  jobId: string,
): Promise<ReusableApplication | null> {
  const jobInteraction = await prisma.jobInteraction.findFirst({
    where: { jobId, userId },
    select: {
      coverLetter: true,
      coverLetterReuse: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      job: {
        select: {
          title: true,
          companyName: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  if (!jobInteraction) return null;

  const allAnswers = Array.isArray(jobInteraction.shortAnswers)
    ? (jobInteraction.shortAnswers as Array<{
        question: string;
        answer: string;
      }>)
    : [];
  const reuse = Array.isArray(jobInteraction.shortAnswersReuse)
    ? (jobInteraction.shortAnswersReuse as Array<boolean | null>)
    : [];

  return {
    jobTitle: jobInteraction.job?.title ?? "(unknown role)",
    companyName:
      jobInteraction.job?.company?.name ??
      jobInteraction.job?.companyName ??
      "(unknown)",
    coverLetter:
      jobInteraction.coverLetter && jobInteraction.coverLetterReuse === true
        ? jobInteraction.coverLetter.trim()
        : null,
    shortAnswers: allAnswers.filter((_, idx) => reuse[idx] === true),
  };
}

// The canonical role attributes (roleAttrs.ts) ride along with a prior
// application so a sub-agent can judge which one is *comparable* — same
// seniority / function / work arrangement. That's the signal deciding which
// cover letter's template to mirror, which short answer to adapt, and (for the
// critic) which sibling application is close enough that an inconsistency
// between them matters.
export type PastCoverLetterEntry = RoleAttrs & {
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  snippet: string;
  updatedAt: Date;
};
export type PastShortAnswerEntry = RoleAttrs & {
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  question: string;
  answerSnippet: string;
  updatedAt: Date;
};
export type PastDrafts = {
  coverLetters: PastCoverLetterEntry[];
  shortAnswers: PastShortAnswerEntry[];
};

export async function loadPastDrafts(
  userId: string,
  currentJobId: string,
): Promise<PastDrafts> {
  // Pull the user's prior application work (cover letters + short answers)
  // from JobInteraction. Exclude the current job — we don't want to show the
  // agent its own in-flight draft as "past work."
  const jobInteractions = await prisma.jobInteraction.findMany({
    where: {
      userId,
      NOT: { jobId: currentJobId },
      // Coarse prefilter: any artifact content present. The precise include/
      // exclude decision is the "use when drafting" switch, evaluated per-row in
      // JS below — it can't be expressed cleanly as a SQL predicate over the
      // parallel JSON arrays. (Mirrors loadUserDocuments' broad content filter.)
      OR: [
        { coverLetter: { not: null } },
        { shortAnswers: { not: { equals: null } } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    // Generous cap: drafts are bounded by jobs the user actually worked on
    // (realistically << this). Filtering happens in JS, so the cap only guards
    // a pathological row count, not correctness within normal volumes.
    take: 200,
    select: {
      id: true,
      updatedAt: true,
      coverLetter: true,
      coverLetterReuse: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      job: {
        select: {
          slug: true,
          title: true,
          companyName: true,
          company: { select: { name: true } },
          // Role attributes for comparability (which prior app is closest).
          ...ROLE_ATTR_SELECT,
        },
      },
    },
  });

  const coverLetters: PastCoverLetterEntry[] = [];
  const shortAnswers: PastShortAnswerEntry[] = [];
  for (const i of jobInteractions) {
    const jobTitle = i.job?.title ?? "(unknown role)";
    const companyName =
      i.job?.company?.name ?? i.job?.companyName ?? "(unknown company)";
    // Address the prior application by the role's slug, never an id;
    // fall back to the id only for a slug-less legacy job (resolveJobBySlug in
    // read_reusable_application accepts either).
    const jobSlug = i.job?.slug ?? i.id;
    const attrs = toRoleAttrs(i.job);
    // Cover letter: the "use when drafting" reuse flag alone decides — a plain
    // boolean now (no usedAt-derive). Only content the USER marked reusable
    // (copy / edit / flip the switch) is fed back; an agent draft (reuse false)
    // is never recycled into a new draft until the user opts it in.
    const coverIncluded = i.coverLetterReuse === true;
    if (
      i.coverLetter &&
      coverIncluded &&
      coverLetters.length < PAST_COVER_LETTER_LIMIT
    ) {
      coverLetters.push({
        jobSlug,
        jobTitle,
        companyName,
        ...attrs,
        snippet: truncate(
          i.coverLetter.trim().replace(/\s+/g, " "),
          COVER_LETTER_SNIPPET_CHARS,
        ),
        updatedAt: i.updatedAt,
      });
    }
    if (Array.isArray(i.shortAnswers)) {
      // Parallel "use when drafting" flags — a plain boolean per row now (no
      // usedAt-derive); only rows the user marked reusable are fed back.
      const reuse = Array.isArray(i.shortAnswersReuse)
        ? (i.shortAnswersReuse as Array<boolean | null>)
        : [];
      const entries = i.shortAnswers as Array<{
        question?: unknown;
        answer?: unknown;
      }>;
      for (let idx = 0; idx < entries.length; idx++) {
        if (shortAnswers.length >= PAST_SHORT_ANSWER_LIMIT) break;
        if (reuse[idx] !== true) continue;
        const entry = entries[idx];
        const question =
          typeof entry?.question === "string" ? entry.question.trim() : "";
        const answer =
          typeof entry?.answer === "string" ? entry.answer.trim() : "";
        if (!question || !answer) continue;
        shortAnswers.push({
          jobSlug,
          jobTitle,
          companyName,
          ...attrs,
          question,
          answerSnippet: truncate(
            answer.replace(/\s+/g, " "),
            SHORT_ANSWER_SNIPPET_CHARS,
          ),
          updatedAt: i.updatedAt,
        });
      }
    }
  }
  return { coverLetters, shortAnswers };
}

// Cover letters render as a CATALOG, not content: one line per prior letter with
// job title + role attributes + job slug, so the sub-agent picks the comparable
// role by attributes and reads THAT letter in full (`read_reusable_application`)
// to mirror its template. Bodies never appear here — choosing what's worth
// opening is the read the catalog exists to provoke.
export function formatPastCoverLetterIndex(
  entries: PastCoverLetterEntry[],
): string {
  if (!entries.length) return "(no prior cover letters)";
  return entries
    .map((e) => {
      const attrs = formatRoleAttrs(e);
      return `- ${e.jobTitle} @ ${e.companyName}${attrs ? ` · ${attrs}` : ""} (job=${e.jobSlug})`;
    })
    .join("\n");
}

// Collapse repeat takes on the same question into one group, so every prior
// answer to a question sits together instead of scattered through a
// chronological list. Shared by both short-answer renders below.
function groupByQuestion(
  entries: PastShortAnswerEntry[],
): Array<{ label: string; items: PastShortAnswerEntry[] }> {
  const groups = new Map<
    string,
    { label: string; items: PastShortAnswerEntry[] }
  >();
  for (const e of entries) {
    const key = normalizeForCompare(e.question);
    const g = groups.get(key);
    if (g) g.items.push(e);
    else groups.set(key, { label: e.question, items: [e] });
  }
  return [...groups.values()];
}

// Questions only, no answers — what a caller needs when the only thing it asks
// of a prior answer is whether one EXISTS (applicationDeciderSubAgent, deciding
// draft-vs-ask). Listing the roles it was answered for keeps the reader able to
// tell a comparable prior from a distant one; judging how much of the text is
// actually reusable belongs to whoever writes the draft.
export function formatAnsweredQuestionIndex(
  entries: PastShortAnswerEntry[],
): string {
  if (!entries.length) return "(no prior short answers)";
  return groupByQuestion(entries)
    .map(({ label, items }) => {
      const roles = items
        .map((e) => {
          const attrs = formatRoleAttrs(e);
          return `${e.jobTitle} @ ${e.companyName}${attrs ? `, ${attrs}` : ""} (job=${e.jobSlug})`;
        })
        .join("; ");
      return `- "${label}" — answered for ${roles}`;
    })
    .join("\n");
}

// Short answers are GROUPED BY QUESTION so every prior take on the same question
// sits together (with a count) instead of being scattered through a chronological
// list. Answers are short, so the snippet renders inline; the job slug lets
// the sub-agent deep-read the full answer when the snippet was truncated.
export function formatPastShortAnswersIndex(
  entries: PastShortAnswerEntry[],
): string {
  if (!entries.length) return "(no prior short answers)";
  const out: string[] = [];
  for (const { label, items } of groupByQuestion(entries)) {
    out.push(
      `### "${label}" — ${items.length} prior answer${items.length > 1 ? "s" : ""}`,
    );
    for (const e of items) {
      const attrs = formatRoleAttrs(e);
      out.push(
        `- [${e.jobTitle} @ ${e.companyName}${attrs ? `, ${attrs}` : ""}] (job=${e.jobSlug})`,
      );
      out.push(indent(`A: ${e.answerSnippet}`));
    }
  }
  return out.join("\n");
}

// For the decider (which knows the actual form questions): map each form question
// to any prior short answers that answer the same (or a near-identical) question,
// so a repeat question can be flagged draft-not-ask_user right next to it. Exact
// normalized match first; falls back to a substring match either direction
// ("Why do you want to work here?" ⊂ "Why do you want to work here at Acme?").
export function matchPriorAnswersToForm(
  formQuestions: string[],
  entries: PastShortAnswerEntry[],
): Map<string, PastShortAnswerEntry[]> {
  const byNorm = new Map<string, PastShortAnswerEntry[]>();
  for (const e of entries) {
    const k = normalizeForCompare(e.question);
    const list = byNorm.get(k);
    if (list) list.push(e);
    else byNorm.set(k, [e]);
  }
  const result = new Map<string, PastShortAnswerEntry[]>();
  for (const q of formQuestions) {
    const nq = normalizeForCompare(q);
    let matches = byNorm.get(nq) ?? [];
    if (!matches.length && nq.length > 12) {
      matches = entries.filter((e) => {
        const en = normalizeForCompare(e.question);
        return en.length > 12 && (en.includes(nq) || nq.includes(en));
      });
    }
    if (matches.length) result.set(q, matches);
  }
  return result;
}
