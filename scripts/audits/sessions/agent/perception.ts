// Format an AuditTurn into the text body the auditor model sees as one
// user message per turn. Two sections per turn:
//   - "What the user saw" — the reconstructed visible surface
//   - "Raw correctness signal" — tool inputs, outputs, sub-agent traces
//
// The auditor model needs both views: the visible surface for translation /
// UX / flow judgement, and the raw signal for tool-correctness / silent-
// workaround judgement. Sub-agent traces go in the raw section since they're
// hidden behind a chip expand on the real UI.

import type { AuditTurn } from "../driver/replay";

function fmtTime(d: Date | null): string {
  if (!d) return "(no time)";
  return d.toISOString().slice(11, 19);
}

function stringifyForAuditor(v: unknown, max = 1200): string {
  if (typeof v === "string")
    return v.length > max ? v.slice(0, max) + " …(truncated)" : v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > max ? s.slice(0, max) + " …(truncated)" : s;
  } catch {
    return String(v);
  }
}

function renderTraceStep(step: unknown, depth = 0): string {
  if (!step || typeof step !== "object") return "";
  const s = step as Record<string, unknown>;
  const pad = "  ".repeat(depth);
  if (s.kind === "text") {
    return `${pad}· text: ${stringifyForAuditor(s.text, 240)}`;
  }
  if (s.kind === "tool") {
    const lines: string[] = [];
    lines.push(`${pad}· tool: ${String(s.name)} (id=${String(s.id)})`);
    if (s.input !== undefined)
      lines.push(`${pad}  input: ${stringifyForAuditor(s.input, 400)}`);
    if (s.result !== undefined)
      lines.push(`${pad}  result: ${stringifyForAuditor(s.result, 400)}`);
    if (s.error !== undefined)
      lines.push(`${pad}  ERROR: ${stringifyForAuditor(s.error, 240)}`);
    if (Array.isArray(s.children)) {
      for (const c of s.children) lines.push(renderTraceStep(c, depth + 1));
    }
    return lines.join("\n");
  }
  return `${pad}· ${stringifyForAuditor(step, 240)}`;
}

function renderTrace(t: { toolUseId: string; raw: unknown }): string {
  const r = t.raw as { steps?: unknown[] };
  const steps = Array.isArray(r?.steps) ? r.steps : [];
  const head = `[sub-agent trace under tool_use_id=${t.toolUseId}]`;
  return [head, ...steps.map((s) => renderTraceStep(s, 1))].join("\n");
}

function renderTurnForAuditor(turn: AuditTurn): string {
  const lines: string[] = [];
  lines.push(`========== Turn ${turn.turnIndex} ==========`);
  lines.push(`When: ${fmtTime(turn.userMessageAt)}`);
  lines.push(`User said (id=${turn.userMessageId ?? "(none)"}):`);
  lines.push(turn.userText ? indent(turn.userText, 2) : "  (empty)");

  lines.push("");
  lines.push("---- What the user saw ----");
  if (turn.assistantText) {
    lines.push(`Hank replied:`);
    lines.push(indent(turn.assistantText, 2));
  } else {
    lines.push(`Hank replied: (no visible text)`);
  }
  if (turn.statusLines.length) {
    lines.push("");
    lines.push("Status lines (rendered as · grey text above the chat bubble):");
    for (const s of turn.statusLines) lines.push(`  · ${s}`);
  }
  if (turn.toolChipsTopLevel.length) {
    lines.push("");
    lines.push(
      `Collapsed tool chips visible: ${turn.toolChipsTopLevel.join(", ")}`,
    );
  }
  if (turn.widgets.length) {
    lines.push("");
    lines.push(
      "Pipeline widget(s) shown in the sticky bar above the composer:",
    );
    for (const w of turn.widgets) {
      lines.push(`  [${w.kind}]`);
      if (w.rendered) lines.push(indent(w.rendered, 4));
      else if (w.renderError)
        lines.push(`    !! render error: ${w.renderError}`);
      else lines.push(`    (no rendered text)`);
    }
  }
  if (turn.panelHint) {
    lines.push("");
    lines.push(`Right panel: ${turn.panelHint}`);
  }
  if (turn.stoppedByUser) {
    lines.push("");
    lines.push(
      "!! This reply was cut off mid-turn — a Stop press, a dropped connection, " +
        "or a mid-stream error (assistant content may be partial).",
    );
  }
  if (turn.errorEvent) {
    lines.push("");
    lines.push(
      `!! Error event: ${turn.errorEvent.code ?? ""} ${turn.errorEvent.message ?? ""}`.trim(),
    );
  }

  lines.push("");
  lines.push(
    "---- Raw correctness signal (tool I/O — hidden from user unless they expand a chip) ----",
  );
  if (turn.toolCalls.length === 0) {
    lines.push("(no tool calls this turn)");
  } else {
    for (const c of turn.toolCalls) {
      lines.push(`TOOL ${c.name} (tool_use_id=${c.toolUseId}):`);
      lines.push(indent(`input: ${stringifyForAuditor(c.input, 800)}`, 2));
      if (c.result === null) {
        lines.push(
          `  result: (orphan — no matching tool_result block; turn stopped mid-stream?)`,
        );
      } else if (c.result.isError) {
        // Surface the HANK-354 structured code/dedupHint (when present) so the
        // auditor can reason about + group failure modes without parsing prose.
        const tag = c.result.code
          ? ` [${c.result.code}${c.result.dedupHint ? ` · ${c.result.dedupHint}` : ""}]`
          : "";
        lines.push(
          `  result (ERROR)${tag}: ${stringifyForAuditor(c.result.text, 800)}`,
        );
      } else {
        // draft_application echoes the full drafted artifact in its result.
        // Don't clip it — this is the as-generated draft, which is what to
        // audit for THIS turn's quality (the entitySnapshot below shows the
        // current persisted version). Other tool results stay capped.
        const resultCap = c.name === "draft_application" ? 8000 : 1200;
        lines.push(
          `  result: ${stringifyForAuditor(c.result.text, resultCap)}`,
        );
      }
    }
  }
  if (turn.subAgentTraces.length) {
    lines.push("");
    lines.push(
      "---- Sub-agent traces (hidden behind a chip on the real UI) ----",
    );
    for (const t of turn.subAgentTraces) {
      lines.push(renderTrace(t));
    }
  }

  if (turn.entitySnapshot) {
    lines.push("");
    lines.push(
      "---- What the user could ALSO see outside chat (right panel / Documents — current state, generated at audit time) ----",
    );
    lines.push(turn.entitySnapshot);
  }

  if (turn.flags.length) {
    lines.push("");
    lines.push(
      "---- Deterministic heuristic flags (the harness pre-detected these — verify before believing) ----",
    );
    for (const f of turn.flags) lines.push(`  ⚠ ${f}`);
  }

  return lines.join("\n");
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

// Render an entire chunk (N turns + the prior chunk's forward summary)
// into one user message for the chunked auditor loop. Each turn keeps its
// full per-turn perception — no compression. The prior summary carries the
// "what you knew going in" context so the chunk reader doesn't start fresh.
export function renderChunkForAuditor(args: {
  chunkIndex: number; // 1-based
  totalChunks: number;
  turns: AuditTurn[];
  priorForwardSummary: string | null; // null for the very first chunk
  isFinalChunk: boolean;
}): string {
  const out: string[] = [];
  const firstTurn = args.turns[0].turnIndex;
  const lastTurn = args.turns[args.turns.length - 1].turnIndex;

  out.push(
    `# Chunk ${args.chunkIndex} of ${args.totalChunks} — turns ${firstTurn} to ${lastTurn} (${args.turns.length} turn${args.turns.length === 1 ? "" : "s"})`,
  );
  out.push("");

  out.push("## What you knew going in");
  if (args.priorForwardSummary) {
    out.push(args.priorForwardSummary);
  } else {
    out.push("(This is the first chunk — no prior context yet.)");
  }
  out.push("");

  out.push(`## This chunk — full per-turn perceptions`);
  out.push("");
  for (const turn of args.turns) {
    out.push(renderTurnForAuditor(turn));
    out.push("");
  }

  out.push("---");
  out.push("");
  out.push("## Your task for this chunk");
  out.push("");
  out.push(
    "Audit EVERY turn above against EVERY vector below. This is a thoroughness pass — the cost of missing a real issue is the bug shipping unchanged to the next session, multiplied by every user who hits it. The cost of a false positive is one row the admin dismisses in two seconds. **Lean toward filing.**",
  );
  out.push("");
  out.push("For each turn, walk through every vector before moving on:");
  out.push("");
  out.push(
    "1. **Tool correctness** — did each tool return what Hank expected? Were errors handled correctly or silently routed around? (Hank no longer self-reports tool failures — YOU are the diligence layer, so a non-trivial failure that went unaddressed is your finding to file.)",
  );
  out.push(
    "2. **Silent workarounds** — if Hank fell back from a primary path (`get_application_form` → `fetch_url`, `search_jobs` → ask user, etc.), can you name a SPECIFIC reason the primary path failed? If not, file a `tool_misbehavior` finding.",
  );
  out.push(
    "3. **Translation discipline** — scan every assistant text + widget render for: enum codes (CAUGHT_UP, SHORTLISTED, DEFERRED, …), skip/defer reason codes, tool names (search_jobs, propose_shortlist_auto, …), memory paths (profile.md, …), mode/rung vocab (walkthrough mode, rung 0), internal entity names (JobInteraction, MemoryNote), model framing (Sonnet/Haiku/Opus/context window/compaction). File one observation per distinct leak — these recur and dedup will collapse them.",
  );
  out.push(
    "4. **Flow / mode compliance** — was the right tool picked? Was sticky company focus maintained? Was `compact_chat` run between companies? Was the walkthrough not batched? Did Hank act-don't-ask at decision points? Did `set_focus` precede user-visible work on a new entity?",
  );
  out.push(
    "5. **Data integrity** — did status transitions stay consistent? Are FKs intact post-action? Did SHORTLISTED/APPLIED/DEFERRED jobs stay consistent with parent company status? Any orphan rows the agent created and didn't clean up?",
  );
  out.push(
    '6. **User satisfaction signals** — frustration phrases ("no", "ugh", "wait", "why didn\'t that work", "..."), repeated rephrasings (user asked same thing twice), corrections, user doing the work themselves ("I\'ll just check"). Quote the user\'s exact phrase. File one `user_confusion` per signal.',
  );
  out.push(
    "7. **Cost / efficiency** — wasted tool calls, redundant `set_focus` clears, sub-agent over-escalation (`propose_shortlist_auto` on a 2-job board), `compact_chat` no-ops on short chats, repeated reads of the same memory.",
  );
  out.push(
    "8. **Widget UX** — for each widget shown, does the render make sense? Right buttons, right framing? Does per-job `hankReasons` text translate well? Are sub-agent rationales coherent given the user profile?",
  );
  out.push("");
  out.push(
    "Before moving from one turn to the next, ask: *have I considered each vector for this turn?* Don't let busy turns drown out small issues; don't let clean turns fool you into skimming the next one. If you saw a pattern recur (the same dedupKey from a prior turn), reuse the dedupKey verbatim so the upsert bumps occurrenceCount — don't invent a new key.",
  );
  out.push("");
  if (args.isFinalChunk) {
    out.push(
      "This is the FINAL chunk. After your `commit_chunk_findings` call returns, you'll get a wrap-up turn that includes all forward summaries + the final state snapshot — that's where you emit cross-chunk patterns and overall assessment. For now, focus only on this chunk.",
    );
  } else {
    out.push(
      "This is one of several chunks. Your `forwardSummary` field is what the next chunk reader will see as 'what you knew going in' — make it tight signal, not narrative. Track recurring dedupKeys with running counts so the next chunk recognizes recurrence and bumps cleanly.",
    );
  }
  out.push("");
  out.push(
    "Emit one `commit_chunk_findings` call with every finding from these turns + the forwardSummary.",
  );
  return out.join("\n");
}

// Render the wrap-up call's user message: every chunk's forwardSummary +
// the final state snapshot, plus the cross-window task framing.
export function renderWrapUpForAuditor(args: {
  forwardSummaries: string[];
  finalStateSnapshotText: string;
}): string {
  const lines: string[] = [];
  lines.push("# Wrap-up — cross-window synthesis");
  lines.push("");
  lines.push(
    "All chunks have been processed. Each `commit_chunk_findings` you made was filed to AdminNote immediately. Now you have the full picture.",
  );
  lines.push("");
  lines.push("## What you wrote forward across chunks");
  lines.push("");
  for (let i = 0; i < args.forwardSummaries.length; i++) {
    lines.push(`### After chunk ${i + 1}`);
    lines.push("");
    lines.push(args.forwardSummaries[i]);
    lines.push("");
  }
  lines.push("## Final state snapshot");
  lines.push("");
  lines.push(args.finalStateSnapshotText);
  lines.push("");
  lines.push("## Your wrap-up task");
  lines.push("");
  lines.push("Emit one `audit_wrap_up` call carrying:");
  lines.push(
    "- `overallAssessment`: 1-4 honest paragraphs on session quality across the whole window. Dominant patterns, what's broken vs working, what the user experience actually felt like. Be specific — name the worst moments, name the best moments.",
  );
  lines.push(
    "- `wrapUpFindings`: cross-window findings that only become obvious now:",
  );
  lines.push(
    "  - Data integrity issues visible in the state snapshot but not in any single turn (orphan jobs at terminal companies, stale Opportunity rows, mismatched status pairs).",
  );
  lines.push(
    "  - Frequency patterns (X recurred N times across the audit — escalate severity if you saw the same dedupKey bump >3 times).",
  );
  lines.push(
    "  - Cross-flow behaviors (translation slips clustered on certain tool result shapes; silent workarounds clustered on certain tool families).",
  );
  lines.push(
    "  - Anything you held back during the per-chunk passes because you weren't sure it was a pattern yet.",
  );
  lines.push("");
  lines.push(
    "Don't repeat findings already filed mid-chunk unless the pattern's severity should now escalate. Re-use the same dedupKey verbatim so the upsert bumps instead of duplicating.",
  );
  return lines.join("\n");
}
