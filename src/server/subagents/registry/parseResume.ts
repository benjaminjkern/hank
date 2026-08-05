import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";

// Anthropic, not DeepSeek: this sends the résumé as a document content block,
// which DeepSeek's Anthropic-compatible endpoint rejects. Don't "optimize" it
// onto a DeepSeek model — the request 400s.
const MODEL: LlmModel = "claude-sonnet-4-6";
// Room for a full transcription of a long résumé MERGED with an existing
// background note — the output is the whole note, not this document's share.
const MAX_TOKENS = 16384;

// A merge that comes back a fraction of what it replaces has dropped the
// background rather than folded into it. Same shrink signature the write_memory
// clobber guard watches for; a real merge is the same length or longer.
const CLOBBER_SHRINK_RATIO = 0.5;

export type ParsedResume = {
  // The user's WHOLE background once this document is folded in — written to
  // resume.md verbatim. Not a diff, and not just this document's contents.
  markdown: string;
};

const COMMIT_BACKGROUND_SCHEMA: SubAgentOutputSchema = {
  name: "commit_background",
  description:
    "Persist the user's complete background note. Must be called once per parse.",
  inputSchema: {
    type: "object" as const,
    properties: {
      markdown: {
        type: "string",
        description:
          "The user's COMPLETE background as markdown: every role, date, responsibility, project, achievement, technology and education entry from this document, merged with everything already in the existing background. This REPLACES the note wholesale, so anything left out is lost.",
      },
    },
    required: ["markdown"],
  },
};

// A résumé arrives either as PDF bytes (sent as a document block) or as text
// already extracted from a Word doc — same parse, different content block.
// `existingBackground` is the current resume.md: empty on a first upload (a
// straight transcription), otherwise what this document merges into.
export type ParseResumeInput = {
  fileName: string;
  existingBackground: string | null;
  source: { kind: "pdf"; bytes: Uint8Array } | { kind: "text"; text: string };
};

const TRANSCRIBE_INSTRUCTIONS = `Convert this résumé into markdown and emit it via commit_background.

- **Complete.** Every role, employer, date range, title, bullet, project, achievement, technology, certification and education entry on the page appears in the output. This is a transcription, NOT a summary — don't condense bullets, don't drop the short roles, don't collapse a five-bullet role into one sentence.
- **Faithful.** Nothing that isn't on the page: no inferred seniority, no invented metrics, no filled-in gaps.
- **Facts only.** Skip the letterhead — name, address, phone, email, portfolio links. A résumé's own "Objective"/"Summary" blurb is self-marketing rather than a fact about the background; leave it out.
- **Structured.** \`## Roles\` / \`## Education\` / \`## Skills\` / \`## Projects\` sections, a \`### Title — Employer (dates)\` heading per role, bullets underneath.`;

const MERGE_INSTRUCTIONS = `The user already has a background note (below). Fold this document into it and emit the COMPLETE merged result via commit_background — your output REPLACES the note, so everything still true has to be in it.

- **Lose nothing.** Every fact in the existing note survives unless this document directly corrects it. That note holds things no résumé has — roles the user described in chat, scope details, corrections they made by hand. Those stay.
- **Merge, don't stack.** A role described in both places becomes ONE entry carrying the union of their detail. Never two headings for one job, never a "From <filename>" section. Two genuinely different roles at the same employer stay separate.
- **This document wins a direct conflict** about the same fact (a title, a date range, a metric) — it's the newer statement. Which role is more RECENT is settled by the dates, not by which source it came from.
- **Complete, faithful, facts only, structured** — exactly as for a first transcription: every role/bullet/project/technology from this document appears, nothing invented, no contact details, no "Objective" blurb.`;

// A first upload is a pure transcription; a later one merges into what's there.
// Same call either way — the existing note's presence is the whole switch.
function instructionsFor(input: ParseResumeInput): string {
  const existing = input.existingBackground?.trim();
  return existing
    ? `${MERGE_INSTRUCTIONS}\n\n<existing-background>\n${existing}\n</existing-background>`
    : TRANSCRIBE_INSTRUCTIONS;
}

// commit_background is this parser's output schema, not a tool — it gets a plain
// caption, never a tool span. See lib/types.ts's header for the distinction.
// Success is silent: the merged background IS the caller's return value.
//
// Callers treat an unparseable résumé as fatal (there's nothing to save), so
// every one of them turns `{ok:false}` into a throw.
//
// Still named for parsing though it also merges: the input is a résumé and the
// job is "turn this document into the user's background." The name is also the
// `TokenUsage.operation` key, so a rename costs a data migration to draw a
// distinction the schema description already carries.
export const parseResumeSubAgent: SubAgentDef<
  ParseResumeInput,
  ParsedResume,
  ParsedResume
> = {
  name: "parse_resume",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "List every role, project and education entry in the document, in order. If an existing background is shown, walk IT the same way and mark which entries this document also covers (same role → merge) and which it doesn't (carry forward untouched), plus any direct conflict and which way you're resolving it. With no existing background say so in one line and move on — a first upload is a straight transcription.",
  },
  // No system prompt: the instructions ride with the document itself.
  userContent: (input) =>
    input.source.kind === "pdf"
      ? [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(input.source.bytes).toString("base64"),
            },
          },
          {
            type: "text",
            text: `${instructionsFor(input)}\n\nThe résumé is ${input.fileName}, attached above.`,
          },
        ]
      : [
          {
            type: "text",
            text: `${instructionsFor(input)}\n\nRésumé text extracted from ${input.fileName} (originally a Word document):\n\n<resume>\n${input.source.text}\n</resume>`,
          },
        ],
  outputSchema: COMMIT_BACKGROUND_SCHEMA,
  usageNotes: (input) => input.fileName,
  caption: (input) =>
    input.source.kind === "pdf"
      ? `Reading PDF resume (${input.source.bytes.byteLength.toLocaleString()} bytes)…`
      : `Reading resume text (${input.source.text.length.toLocaleString()} chars)…`,
  // Reject a merge that came back a fraction of what it's about to overwrite —
  // structurally wrong, so it never reaches the caller as a success.
  parse(output, input) {
    const merged = output.markdown?.trim() ?? "";
    if (!merged) throw new Error("commit_background returned empty markdown");
    const existingLen = (input.existingBackground ?? "").trim().length;
    if (merged.length < existingLen * CLOBBER_SHRINK_RATIO) {
      throw new Error(
        `merged background (${merged.length} chars) dropped most of the existing background (${existingLen} chars) — refusing to overwrite it`,
      );
    }
    return { markdown: merged };
  },
};
