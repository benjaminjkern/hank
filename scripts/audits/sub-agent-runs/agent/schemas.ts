// Forced tool the runtime auditor emits once per chunk of real sub-agent runs.
// Two finding kinds:
//   - weird_output   → the sub-agent's real response was wrong / off / degraded
//                      (files an AdminNote under category "tool_misbehavior").
//   - coverage_gap   → this real use-case shape isn't represented by any of the
//                      sub-agent's static fixtures (files under "self_improvement").
// The auditor supplies a short `shape` slug; the harness builds the dedupKey
// (`subagent_runtime:weird_output:<op>:<shape>` / `subagent_coverage_gap:<op>:<shape>`)
// so the convention stays single-sourced and repeats collapse.

import type Anthropic from "@anthropic-ai/sdk";

export const COMMIT_RUNTIME_FINDINGS_TOOL: Anthropic.Tool = {
  name: "commit_runtime_findings",
  description:
    "Forced once per chunk. Emit every finding for THIS chunk's runs (weird outputs AND coverage gaps) plus a forward-summary memo the next chunk of this same sub-agent reads as 'what you already found'. Emit nothing (empty findings) if every run looks reasonable and is covered by an existing fixture shape.",
  input_schema: {
    type: "object",
    required: ["findings", "forwardSummary"],
    properties: {
      findings: {
        type: "array",
        description:
          "One entry per distinct problem or coverage gap found in this chunk's runs. A single run can yield both a weird_output and a coverage_gap finding.",
        items: {
          type: "object",
          required: [
            "runId",
            "kind",
            "severity",
            "shape",
            "summary",
            "context",
          ],
          properties: {
            runId: {
              type: "string",
              description:
                "The exact SubAgentRun id (from the run's header) this finding is about.",
            },
            kind: {
              type: "string",
              enum: ["weird_output", "coverage_gap"],
              description:
                "weird_output = the sub-agent's actual response was wrong, off-target, internally inconsistent, ignored its input, hallucinated, leaked internal vocabulary, or otherwise degraded. coverage_gap = this real use-case shape is NOT represented by any listed static fixture (the sub-agent may have handled it fine — the gap is in the TEST suite).",
            },
            severity: {
              type: "string",
              enum: ["LOW", "MEDIUM", "HIGH"],
              description:
                "weird_output: HIGH = clearly wrong/harmful call, MEDIUM = suboptimal, LOW = minor. coverage_gap: HIGH = a materially different shape likely to expose untested behavior, LOW = a near-duplicate of an existing fixture.",
            },
            shape: {
              type: "string",
              description:
                "Short lowercase snake_case slug naming this use-case shape (e.g. `contract_role`, `empty_pool`, `off_thesis_sales`, `non_english_posting`). Becomes part of the dedupKey — reuse the SAME slug for the same recurring shape so repeats collapse.",
            },
            summary: {
              type: "string",
              description:
                "One sentence, ≤180 chars. No internal file paths or model/token jargon.",
            },
            context: {
              type: "string",
              description:
                "3–12 lines. For weird_output: quote the specific part of the output that's wrong and say why, referencing the input. For coverage_gap: name the closest existing fixture and what differs, then propose a concrete fixture stub to add (name + the scenario it should encode).",
            },
          },
        },
      },
      forwardSummary: {
        type: "string",
        description:
          "≤2000 chars. Carried into the next chunk of THIS sub-agent as 'what you already found'. Cover: recurring weird-output patterns (shape: count), coverage-gap shapes already filed (so you don't re-file), and any behavior that looks off but isn't finding-worthy yet. Terse — signal, not narrative.",
      },
    },
  },
};

export const RUNTIME_CHUNK_TOOLS: Anthropic.Tool[] = [
  COMMIT_RUNTIME_FINDINGS_TOOL,
];
