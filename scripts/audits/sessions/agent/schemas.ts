// Tool schemas for the chunked session-audit Opus loop.
//
// Per chunk: the auditor receives N turns of perception (default 50) plus the
// forward-summary the previous chunk wrote, and emits ONE forced
// `commit_chunk_findings` call carrying:
//   - findings: every distinct issue across the N turns, tagged by turnIndex
//   - forwardSummary: a memo for the next chunk so it doesn't have to start
//     cold (user-profile signals revealed, recurring patterns + dedupKeys
//     being tracked, open threads, state decisions made)
//
// At the very end: one `audit_wrap_up` call that sees every chunk's forward
// summary + the final state snapshot and emits cross-window pattern findings
// plus an overall assessment.

import { ADMIN_NOTE_CATEGORIES } from "@/server/platform/admin/adminNotes";

import type Anthropic from "@anthropic-ai/sdk";

const FINDING_PROPERTIES = {
  category: {
    type: "string",
    enum: [...ADMIN_NOTE_CATEGORIES],
    description: "Closest AdminNote category from the rubric.",
  },
  severity: {
    type: "string",
    enum: ["LOW", "MEDIUM", "HIGH"],
    description:
      "HIGH = tool broke / user visibly frustrated / known-good baseline failed user-side. " +
      "MEDIUM = worked around / friction noticed. " +
      "LOW = cosmetic / mild / one-off. Default MEDIUM when uncertain.",
  },
  summary: {
    type: "string",
    description: "One sentence, ≤180 chars, naming the failure.",
  },
  context: {
    type: "string",
    description:
      "3-12 lines: turn index(es), message IDs, verbatim user/assistant quotes that ground the claim, root-cause hypothesis. Quote what you read; don't paraphrase the evidence.",
  },
  dedupKey: {
    type: "string",
    description:
      "<source>:<failure_mode>:<input_shape>. Reuse existing dedupKeys verbatim (listed in the system prompt) to bump the existing row's occurrenceCount rather than insert a new row. Conventions in the rubric.",
  },
} as const;

export const COMMIT_CHUNK_FINDINGS_TOOL: Anthropic.Tool = {
  name: "commit_chunk_findings",
  description:
    "Forced once per chunk. Emit every distinct finding from this chunk's turns AND a forward-summary memo for the next chunk. " +
    "Each finding becomes one upsertAdminNote call IMMEDIATELY when the chunk returns — file generously; dedup collapses duplicates. " +
    "The forwardSummary is what the NEXT chunk's reader needs to know so they don't start fresh.",
  input_schema: {
    type: "object",
    required: ["findings", "forwardSummary"],
    properties: {
      findings: {
        type: "array",
        description:
          "All distinct findings from this chunk's turns. Empty array is allowed but unlikely — if you scanned 50 turns and found nothing, double-check every vector first.",
        items: {
          type: "object",
          required: [
            "turnIndex",
            "category",
            "severity",
            "summary",
            "context",
            "dedupKey",
          ],
          properties: {
            turnIndex: {
              type: "integer",
              description:
                "Which turn within the audit window this finding belongs to (the [Turn N] header in the perception). Use the smallest turnIndex where this issue first manifests in this chunk.",
            },
            ...FINDING_PROPERTIES,
          },
        },
      },
      forwardSummary: {
        type: "string",
        description:
          "≤2500 chars. Carried forward as the next chunk's 'what you knew going in' section. Cover:\n" +
          "1) USER PROFILE signals revealed in this chunk (preferences, constraints, voice).\n" +
          "2) RECURRING PATTERNS you're tracking (`dedupKey: occurrenceCount; one-line description`), one per line. The next chunk will use these to recognize recurrence and bump rather than re-file.\n" +
          "3) OPEN THREADS (e.g. 'user paused Hebbia until cover letters', 'drafting in flight on Anthropic role X', 'awaiting recruiter reply at Y').\n" +
          "4) STATE DECISIONS made this chunk (companies focused/closed/deferred, applications submitted/skipped).\n" +
          "5) ANYTHING OFF but not finding-worthy yet — soft suspicions for the next chunk to either confirm or dismiss.\n" +
          "Be terse; this is signal, not narrative.",
      },
    },
  },
};

export const AUDIT_WRAP_UP_TOOL: Anthropic.Tool = {
  name: "audit_wrap_up",
  description:
    "Forced after the last chunk. You'll receive every chunk's forwardSummary plus the final state snapshot. " +
    "Emit cross-window pattern findings + an honest overall assessment.",
  input_schema: {
    type: "object",
    required: ["overallAssessment", "wrapUpFindings"],
    properties: {
      overallAssessment: {
        type: "string",
        description:
          "1-4 paragraphs. Honest summary of session quality across the whole window: dominant patterns, what's broken vs working, what the user's experience felt like. Goes into the report; not filed as an AdminNote.",
      },
      wrapUpFindings: {
        type: "array",
        description:
          "Cross-window findings that only become obvious at session scope: data-integrity issues from the state snapshot, frequency patterns (X recurred Y times across N chunks), cost-spend rollups, cross-flow behaviors. Each becomes one upsertAdminNote call.",
        items: {
          type: "object",
          required: ["category", "severity", "summary", "context", "dedupKey"],
          properties: FINDING_PROPERTIES,
        },
      },
    },
  },
};

export const CHUNK_TOOLS: Anthropic.Tool[] = [COMMIT_CHUNK_FINDINGS_TOOL];
export const WRAP_UP_TOOLS: Anthropic.Tool[] = [AUDIT_WRAP_UP_TOOL];
