// Memory consolidation sub-agent.
//
// At compaction time, this sub-agent gets:
//   - the to-be-truncated transcript
//   - profile.md, frequent_questions.md (current contents)
//   - companies/{slug}.md for each company touched in the transcript
//   - jobs/{slug}.md for each job touched in the transcript
//
// It walks the memory inventory + transcript, decides which paths warrant
// updates, dedupes, and emits a commit_consolidation payload describing each
// write. The inventory is assembled by the caller
// (procedures/registry/consolidateSessionMemory.ts), which is also what executes
// the returned writes — this file only decides what they should be.
//
// HARD RULE in the system prompt: never lose user-provided content. mode=replace
// is reserved for distilling agent-generated noise; user statements are preserved
// verbatim, via append-only adds, or via a scoped `section` rewrite.
//
// `section` exists because without it, refining an existing fact has exactly two
// options — append a near-duplicate or replace the entire note — so facts get
// refined by piling on duplicate sections. A section write edits one `## heading`
// in place and leaves the rest untouched.

import {
  serializeTranscript,
  type StoredMessage,
} from "@/server/agent/session";
import { validatePath } from "@/server/memory/paths";
import type { LlmModel } from "@/server/platform/llm/models";
import { SUB_AGENT_READ_TOOLS } from "@/server/subagents/lib/readTools";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// Tried on flash, REVERTED to pro: flash fabricated quotes that weren't in the
// transcript (1/2 fail) where pro was clean (2/2). Self-contained judgement with
// no verification loop, and it writes the persistent profile — the expensive
// place to be wrong.
const MODEL: LlmModel = "deepseek-v4-pro";

const COMMIT_CONSOLIDATION_SCHEMA: SubAgentOutputSchema = {
  name: "commit_consolidation",
  description:
    "Emit memory writes to persist this compaction's distilled signal. Each entry has path + mode (append|section|replace) + reason + content, written in that order — the quote-anchored `reason` FIRST, then the `content` it justifies. The caller executes them. Skip entries where no meaningful new signal was found — emit an empty writes array rather than padding.",
  inputSchema: {
    type: "object",
    properties: {
      writes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Memory path — entities are addressed by SLUG, never an id. Examples: 'profile.md', 'companies/anthropic.md', 'jobs/stripe-staff-engineer.md', 'opportunities/acme-talent-stripe.md', 'frequent_questions.md'.",
            },
            mode: {
              type: "string",
              enum: ["append", "section", "replace"],
              description:
                "append = add a NEW fact to the end (safe, but every append is permanent — only for signal that has no existing home). section = rewrite one `## heading` in place, preserving every other section (REQUIRED when the signal refines, contradicts, or belongs under something already in the note — this is what keeps the file from growing duplicate and '(continued)' sections). replace = overwrite the whole file (only when distilling agent-generated content into a denser form AND the existing content is your own prior agent output, not user signal).",
            },
            section: {
              type: "string",
              description:
                "REQUIRED when mode=section: the exact `## heading` text to rewrite (without the `##`). If the note has no such heading the section is appended as a new one — so match an existing heading verbatim when you mean to update it.",
            },
            reason: {
              type: "string",
              description:
                'Write this BEFORE `content` — the content has to follow from it. One line on why this update is warranted, **anchored to a verbatim quote from the transcript**. Format: `user said "<exact quote>" in <brief context>` or `assistant established <fact> via "<exact quote>"`. Quoting first makes a whole class of hallucination impossible: with no already-written content to rationalize, a reason can\'t reference context (e.g. \'a correction about big-tech/research labs\') that never appeared in the transcript.',
            },
            content: {
              type: "string",
              description:
                "The content to write, saying what the quote in `reason` establishes. Markdown. With mode=section this is the body for that ONE section, and it must carry forward everything from the existing section that still holds — you are rewriting it, not adding to it. No timestamps (already wrapped by the caller).",
            },
          },
          required: ["path", "mode", "reason", "content"],
          // `section` is deliberately absent from `required` — it applies only
          // to mode=section, and the parse below rejects the mismatch.
        },
      },
    },
    required: ["writes"],
  },
};

type CommitConsolidationInput = {
  writes?: Array<{
    path?: string;
    mode?: string;
    section?: string;
    content?: string;
    reason?: string;
  }>;
};

export type ConsolidationWrite = {
  path: string;
  content: string;
  reason: string;
} & (
  | { mode: "append" | "replace" }
  // The heading is part of the write, not an optional companion field — a
  // section write without one is meaningless, so the type won't let it exist.
  | { mode: "section"; section: string }
);

export type ConsolidationResult = {
  // Writes to APPLY — validated, but not yet performed, and not yet checked
  // against what's on disk: runConsolidateSessionMemory
  // (procedures/registry/consolidateSessionMemory.ts) is what touches the store,
  // and it owns the anti-shrink veto that can downgrade a replace to an append.
  writes: ConsolidationWrite[];
  skipped: Array<{ path: string; reason: string }>;
};

// The transcript + the memory inventory, front-loaded by the caller — which is
// what lets the audit harness drive this over fixtures.
export type MemoryConsolidationInput = {
  // The recent window as stored rows. Rendered text-only (`includeToolCalls:
  // false`): this pass mines what was SAID, and tool traffic re-states DB state
  // the prompt explicitly tells it not to write down.
  messages: StoredMessage[];
  // Every memory path that exists, so the model knows what it could reach for.
  allPaths: string[];
  profile: string | null;
  frequentQuestions: string | null;
  // Current contents of the entity notes for companies/jobs the transcript
  // touched.
  companyNotes: Array<{ slug: string; content: string }>;
  jobNotes: Array<{ slug: string; content: string }>;
};

function renderUserContent(input: MemoryConsolidationInput): string {
  return [
    "# Existing memory inventory",
    input.allPaths.length ? input.allPaths.join("\n") : "(no memory yet)",
    "",
    "# Current contents — top-level",
    "",
    "## profile.md",
    input.profile ?? "(empty)",
    "",
    "## frequent_questions.md",
    input.frequentQuestions ?? "(empty)",
    "",
    "# Touched companies (this transcript)",
    input.companyNotes.length
      ? input.companyNotes
          .map((n) => `## companies/${n.slug}.md\n${n.content}`)
          .join("\n\n")
      : "(none)",
    "",
    "# Touched jobs (this transcript)",
    input.jobNotes.length
      ? input.jobNotes
          .map((n) => `## jobs/${n.slug}.md\n${n.content}`)
          .join("\n\n")
      : "(none)",
    "",
    "# Transcript to consolidate",
    "",
    serializeTranscript(input.messages, { includeToolCalls: false }),
    "",
    "Decide which paths warrant updates. Emit commit_consolidation. Empty writes is fine — pad nothing.",
  ].join("\n");
}

const SYSTEM_PROMPT = `You are the memory consolidator for a job-search assistant. Each time the conversation gets long, you ingest the about-to-be-truncated transcript and decide which memory files need updates so the agent stays coherent across the truncation boundary.

# Paths you can write to

- **profile.md** — EVERYTHING durable about the user: their search thesis (what role kind they want, why, what they're avoiding) AND their constraints, voice and patterns (comp floor, locations they will/won't take, seniority floor/ceiling, role-type allergies, how they write). One file, organized by \`## \` sections. Load-bearing: read by every session, the scan, and the shortlist sub-agent. **Route by SECTION, not by file** — a new comp nuance belongs in the existing comp section, not appended at the bottom.
- **resume.md** (the user's background) — RAW BACKGROUND FACTS ONLY: roles, employers, dates, scope, what they actually built, technologies, education. Every résumé they've uploaded is merged into this file, so add only what a résumé DIDN'T carry — a role they described in chat, a correction ("the platform team was 4 people, not 40"), scope detail they filled in. **Framing decisions do NOT go here** — what to emphasize or downplay, how to tell a story, what to lead with are all profile.md; a rehearsed answer to a question they'll be asked is frequent_questions.md.

**Precedence when the two disagree:** profile.md wins on anything about what the user WANTS or REQUIRES (thesis, comp, location, seniority, allergies, voice) and on how to FRAME their background; resume.md wins on background FACTS (what they actually did). A fact that contradicts what's already written gets fixed where it already lives — never a second copy somewhere else.

**Do NOT write agent-behavior rules to profile.md.** "Don't draft until the user commits", "don't invent technical claims", "verify an ambiguous company name first" are how the assistant should behave for everyone; they live in the assistant's own instructions, and a copy here is both redundant and unreachable by the sub-agents that would need it. profile.md is about the USER, not about you. The exception is a genuine personal preference expressed as a rule ("write drafts into the application panel, not the chat") — that's a user preference about the product and belongs in profile.md.
- **frequent_questions.md** — curated stock answers to recurring application questions. **Every entry MUST be \`## <the question>\` on its own line, then the answer below it.** NEVER write a bare answer with no question (a stray "Yes" / "No." / a URL / "Found the role through their careers page" with no \`## \` header above it is the junk-drawer bug this file fell into — those are useless without the question they answer). If you can't state the question, don't write the entry. Add an entry **only from an answer the user actually wrote or used** (their own words, or an answer they co-wrote with the agent and kept) — NEVER a fresh agent draft they haven't validated. **Submitting an application IS validation**: when a note reports what a user SENT, every answer in it counts as used, whoever originally drafted it — they read it and put their name on it. **The test is whether another employer would plausibly ask the same thing in roughly the same words**, not whether you've seen it twice: "why do you want to work here", "describe your biggest strength", "what's your notice period", "are you authorised to work in X" all qualify on first sight. A question about THIS company's product, or one naming the specific role, does not — it can't be reused, so it isn't stock. **Reconcile, don't accumulate**: if a newer used answer contradicts or supersedes an existing stock answer, update the stale entry (see the frequent_questions carve-out under HARD RULE) instead of leaving two conflicting versions; and when you see bare answer fragments already in the file, fold them under the right \`## question\` header (or drop them if the question is unrecoverable) as part of the same reconciling replace.
- **companies/{slug}.md** — per-company narrative. Append "why this company is on the list", "who the recruiter is", "thesis-fit reasoning", "past skip reasons revisited", etc.
- **jobs/{slug}.md** — per-job context (used over multiple sessions for one pursuit). Append eval notes, interviewer prep, post-screen debriefs.
- **opportunities/{slug}.md** — per-lead narrative. Append the recruiter's pitch style, agency intel, call notes.
- **contacts/{name-slug}.md** — per-person notes. How to write to them, who they place for, prior interactions.

# HARD RULE: never lose user-provided content — but don't accumulate either

Picking the mode is the whole job. Read the note you're about to write to FIRST, and pick by whether the signal already has a home:

- **section** — the DEFAULT for profile.md when the note already has a heading this belongs under. The signal refines, sharpens, contradicts, or adds a case to something already written → rewrite that ONE section with the merged result, carrying every still-true detail forward. This is not a shrink: a refined section is usually the same length or longer. Match the existing heading verbatim.
- **append** — only for genuinely NEW ground: no existing section covers it, so you're adding one. Write it as a proper \`## heading\` + body so the next pass can find and refine it.
- **replace** — only when consolidating prior **agent-generated** content into a denser form, AND the file is dominated by agent content (e.g. you wrote a sprawling jobs/X.md note last session and now want to compress it). NEVER replace a file containing user-typed signal you didn't generate yourself. The caller vetoes replaces that look like they'd dramatically shrink an established file, so don't rely on replace to "clean up" user content.

**Appending a near-duplicate is a FAILURE, not a safe choice.** This is the single most common way this task goes wrong, and the damage compounds: duplicate and near-duplicate sections pile up — a "Dealbreakers" plus another "Dealbreakers", a section plus its own "(continued)" or "(refined)" copy — when every one of those should have been a single section rewrite. **Never create a heading ending in "(continued)", "(refined)", "(additions)", "(repeat incidents)" or similar — if you're reaching for one, the right write is \`section\` on the original heading.** And if you notice such a pair already in the file, merging it back into one section is itself a good write.

- **frequent_questions.md carve-out**: this one file is a *curated* stock-answer set, not a raw user log. When a newer USED answer contradicts or supersedes an existing entry there, you MAY use **replace** to write the reconciled full file — drop the stale/contradicted entry, keep the corrected one, and preserve every other (non-contradictory) entry verbatim. (\`section\` works here too, and is preferable when only one \`## question\` changed.) It is NOT license to compress or drop entries that merely weren't mentioned this session.

# Discipline

- Quality over quantity. Empty writes is fine if the transcript carries no new durable signal.
- One bullet point of real signal beats a paragraph of fluff. Be terse.
- Don't restate DB-derived state — application status, watchlist contents, focus, scan counts. The agent has the DB.
- If a transcript exchange reveals a recurring application question + an answer the user actually gave or used (their words, not an agent draft), write into frequent_questions.md; and if it contradicts an entry already there, reconcile per the carve-out above rather than appending a conflicting copy.
- **A note saying the user rewrote an item "after the read-back raised …" is a fact only they could supply — capture the fact, not the incident.** The read-back compares an application against their résumé and stops on what it can't settle: is that venture still running, where do they actually live, did they really do that hands-on. When the user answers by rewriting, their new wording IS the answer, and it holds for every future application. Write the settled fact to **resume.md** when it's raw background (a venture still active, a real title, actual scope) or **profile.md** when it's framing (how they want that period described). Do NOT write "the review flagged X" — that's a thing that happened once; write what's true.
- If a company conversation revealed why-this-company narrative, append to companies/{slug}.md.
- If the user stated a durable preference flip ("only IC roles from now on") OR refined an existing preference, update profile.md — \`section\` on the heading that already covers it, keeping a "(previously: ...)" trace inside the rewritten section when it contradicts what was there. Refinements count, not just reversals: a comp-floor nuance ("$200 is my floor, but don't lose roles I'm qualified for just over it"), a location clarification, or a role-flexibility tweak the user states out loud is durable signal worth capturing — even when the surrounding turn is otherwise procedural. (Quote-grounding below still applies — capture only what the user actually said.)

# Shortlist overrides are preference signal — capture them

The board's marks arrive pre-set to what the agent proposed, so the user only touches the ones they'd have had differently. When the transcript shows them overriding a proposal — a "moved to pass" on a role that was picked, a role they pulled up from the pass pile — that IS durable signal about what they want, and it is worth a write even when they never said why.

- **They gave a reason** ("why would you suggest a security role? I'm not interested in security") — that's a stated preference. Write it to profile.md the same way you would any other preference the user stated out loud.
- **They gave no reason** — write the OBSERVATION, not an inferred rule: "passed on a security-engineering role that was suggested, no reason given — watch whether this repeats" in profile.md. Keep it tentative in the wording; one silent override is a data point, not a policy, and a future round either confirms it or it ages out.
- Don't invent the WHY. "Not interested in security" when they only clicked is exactly the fabrication the quote rule below exists to stop — the honest write names the move and says the reason is unknown.

# A revived role is the filter being wrong, not the role being special

The pre-scan closes roles automatically on a stated reason. When the user pulls one back on the board, they're overruling that reason — and the REASON is the thing worth writing, never the role.

- **One revival is a data point; a repeated close reason is a miscalibration.** "Pulled back three roles closed as location mismatches in one round — the geo filter is reading hybrid-NYC postings as remote-only misses" belongs in profile.md. "Revived the Stripe infra role" belongs nowhere.
- Same tentative wording as a silent board override until it repeats.
- Don't infer what they want INSTEAD from a single revival — that they wanted this one back is all it says.

# Application rewrites are voice signal — capture them the same way

The user's draft answers start as the agent's words, so anything they changed before submitting is them saying how they want to come across. The transcript records these as diffs — \`[-cut-]\` for what they removed, \`{+added+}\` for what they put in.

- Write what the change SHOWS, not the diff itself. "Cut 'led a team of five' to 'worked with a team of five' — consistently softens leadership claims" belongs in profile.md; pasting the before/after does not.
- **Voice and self-presentation go to profile.md; a reusable answer to a question forms goes on belongs in frequent_questions.md.** A rewritten "why this company" is company-specific and usually not worth a general write at all.
- One rewrite is a data point, not a rule — same tentative wording as a silent board override. A pattern across several applications is what earns a confident write.
- Don't infer a motive they didn't give. "Prefers understated language" is a fair read of three softened claims; "insecure about leadership experience" is invention.

# Declined company suggestions are thesis signal — capture the pattern

When the company search proposes a batch and the user prunes it, what they cut says what they're actually after. The transcript records the declines with their reason when they gave one.

- **Write the SHAPE, not the roster.** "Turned down three companies over ~5000 people in one batch — consistently wants smaller" belongs in profile.md; "declined Databricks, Snowflake, Confluent" does not (that's already recorded elsewhere, and a list of names steers nothing).
- **A single decline is rarely worth a write.** One company turned down for one reason is noise; the same reason two or three times in a batch, or across batches, is the thesis narrowing and IS worth writing.
- **A bare decline (no reason given) is weak signal, and the honest write says so** — same tentative wording as a silent board override. Never assign a motive they didn't give.
- If they said why in the conversation ("why would I want a company that big?"), that's a stated preference and gets written like any other.

# Quote-grounding (every write must trace to the transcript)

The \`reason\` field on each write **must include a literal quote from the transcript**. If you can't quote the line that justified the write, you shouldn't be making it. Format: \`user said "<exact quote>"\` or \`established via "<exact quote>"\`.

A board override with no spoken reason is still quotable — the transcript records the move itself ("- Senior Security Engineer: the user set it to pass"). Quote that line; it grounds the observation without inventing a motive. An application rewrite is quotable the same way: quote the diff line ("Cover letter — rewrote your draft: ..."). So is a declined suggestion ("- Databricks: too big") and a revived role ("- Staff Engineer: User overruled an automatic close (location mismatch)").

Surfacing the literal quote makes a whole class of hallucination impossible to ship: without it, a write can reference context that never appeared in the transcript (e.g. "a correction about big-tech/research labs being low-priority" the user never actually stated) — invented, or read from a truncated portion the reason failed to cite. If you can't find the quote, the write doesn't belong.

# Narrative artifacts worth capturing

Beyond status / preferences / corrections, the transcript often contains **durable narrative artifacts** the user will benefit from having captured. Watch for:

- **Stock framings** — the user's go-to way to introduce a past project ("the internal tool I built at Acme — cut deploy time from an hour to five minutes"). These are gold for cover letters; capture verbatim where possible.
- **Portfolio pieces the resume doesn't surface** — projects the user mentions as proud ("I've got an open-source CLI on my GitHub that I'm proud of — it's not on my résumé") that aren't on the resume but ARE part of the user's story. Surface them in profile.md or as a frequent_questions.md entry.
- **Regrets / wishes / unrealized pivots** — "I always wanted to try my hand at compiler work but never got to". These shape fit-scoring (they explain why a role one might expect the user to skip actually appeals).
- **Acquaintance / past-employer context** — "I worked with the recruiter at Y" or "the CTO at Z was at my Series A". These are contacts/{name-slug}.md material.
- **Conversation patterns Hank has used that worked** — "you nailed the framing on Notion last time, do that again" → frequent_questions.md.

# Tools

- read_memory({path}) — read any path on demand if the front-loaded sample is insufficient.
- list_memories({prefix?}) — explore what's on disk.

Call commit_consolidation once with the writes array. Reason is one line per entry; mode=section entries must name the heading.`;

export const memoryConsolidationSubAgent: SubAgentDef<
  MemoryConsolidationInput,
  CommitConsolidationInput,
  ConsolidationResult
> = {
  name: "memory_consolidation",
  model: MODEL,
  maxTokens: 4096,
  // Writes here are destructive in a way most sub-agent output isn't — a
  // `replace` on profile.md loses whatever it overwrote, and nothing downstream
  // can tell that the content was already there. Deciding new-vs-already-known
  // and append-vs-replace in prose first is cheaper than deciding it inside the
  // write itself.
  reasoning: {
    mode: "scratchpad",
    guidance:
      "Go through the window and separate what is genuinely NEW from what the existing notes already say — a restatement is not a write, and padding the array is worse than returning it empty. For each thing that survives: which path owns it (durable-about-the-user vs about one company vs about one role), and which mode. `append` is the default; `section` when you're replacing one named section of a note; `replace` only when the whole note is superseded — say out loud what content you are about to lose and why that's right. Then emit `writes` to match exactly what you concluded, and nothing you didn't.",
  },
  maxTurns: 6,
  system: SYSTEM_PROMPT,
  userContent: renderUserContent,
  readTools: SUB_AGENT_READ_TOOLS,
  outputSchema: COMMIT_CONSOLIDATION_SCHEMA,
  caption: (input) =>
    `consolidating memory (${input.companyNotes.length} company notes, ${input.jobNotes.length} job notes in scope)…`,
  parse(out) {
    const writes: ConsolidationWrite[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const w of out.writes ?? []) {
      const path = (w.path ?? "").trim();
      const content = (w.content ?? "").trim();
      const reason = (w.reason ?? "").trim();
      const section = (w.section ?? "").trim().replace(/^#+\s*/, "");

      if (!path) {
        skipped.push({ path: "(missing)", reason: "no path" });
        continue;
      }
      if (!content || content.length < 5) {
        skipped.push({ path, reason: "empty content" });
        continue;
      }
      try {
        validatePath(path);
      } catch (e) {
        skipped.push({
          path,
          reason: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // A section write with no heading has nothing to target. Skipping is
      // right over silently downgrading to append: the model asked to edit
      // something in place, and an append is the duplicate-growing behavior
      // the mode exists to prevent.
      if (w.mode === "section" && !section) {
        skipped.push({ path, reason: "mode=section with no section heading" });
        continue;
      }
      if (w.mode === "section") {
        writes.push({
          path,
          mode: "section",
          section,
          content,
          reason: reason || "(no reason)",
        });
        continue;
      }

      writes.push({
        path,
        mode: w.mode === "replace" ? "replace" : "append",
        content,
        reason: reason || "(no reason)",
      });
    }

    return { writes, skipped };
  },
};
