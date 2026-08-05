// Turn a VisibleTurn into the exact text block the persona "sees" this turn —
// nothing the real user couldn't see, and the widget rendered to plain text
// rather than raw JSON. Also runs a mechanical leak scan over Hank's own words
// (assistant text + widget render): a raw marker, a cuid id, or tool-protocol
// tokens appearing in user-facing copy is a genuine bug, surfaced to the
// persona as a flag so it can halt — we flag, we don't scrub.

import type { VisibleTurn } from "../driver/turnDriver";

// Tokens that should never appear in user-facing copy.
const LEAK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /<!--\s*widget-response/i,
    label: "raw widget-response marker in user-facing text",
  },
  {
    re: /\btool_use_id\b|\bparentToolUseId\b|\btoolUseId\b/,
    label: "tool-protocol token in user-facing text",
  },
  { re: /\bdedupKey\b/, label: "internal dedupKey in user-facing text" },
  {
    re: /\bc[a-z0-9]{24,}\b/,
    label: "raw database id (cuid) in user-facing text",
  },
  {
    re: /\b(currentFlow|focusedCompanyId|focusedJobId|pipeline_widget|pipeline_status)\b/,
    label: "internal state field name in user-facing text",
  },
];

export type Perceived = {
  text: string;
  harnessFlags: string[];
};

export function perceive(turn: VisibleTurn, turnNumber: number): Perceived {
  const lines: string[] = [];

  if (turn.error) {
    lines.push(
      `⚠️ SYSTEM ERROR this turn: ${turn.error.message}${turn.error.code ? ` [${turn.error.code}]` : ""}`,
    );
  }
  if (turn.stopped) {
    lines.push("⚠️ Hank's response was cut off (stopped) this turn.");
  }

  if (turn.assistantText) {
    lines.push(`Hank says:\n${turn.assistantText}`);
  } else if (!turn.widget && !turn.error) {
    lines.push("Hank said nothing this turn (no visible reply).");
  }

  for (const s of turn.statusLines) {
    lines.push(`· ${s}`);
  }

  if (turn.toolChips.length > 0) {
    // A real user sees collapsed chips with the tool name; the internals are
    // hidden unless they expand. We surface only the names.
    lines.push(`(Hank worked on: ${turn.toolChips.join(", ")})`);
  }

  if (turn.widget) {
    if (turn.widget.rendered) {
      lines.push(turn.widget.rendered.text);
      lines.push(`How to respond to this: ${turn.widget.rendered.actionHint}`);
    } else {
      lines.push(
        `⚠️ A widget appeared but rendered as nothing usable (kind=${turn.widget.kind}). As a user you'd see a broken control here.`,
      );
    }
  } else {
    lines.push(
      "(No on-screen widget right now — respond by typing a chat message, i.e. action.type = send_message.)",
    );
  }

  lines.push(turn.panelHint);

  // Mechanical leak scan over Hank's own copy (not the harness chrome).
  const scanCorpus = [
    turn.assistantText,
    turn.widget?.rendered?.text ?? "",
  ].join("\n");
  const harnessFlags: string[] = [];
  for (const { re, label } of LEAK_PATTERNS) {
    if (re.test(scanCorpus)) harnessFlags.push(label);
  }
  if (turn.widget && !turn.widget.rendered) {
    harnessFlags.push(`unrenderable widget kind=${turn.widget.kind}`);
  }

  return { text: `[Turn ${turnNumber}]\n${lines.join("\n\n")}`, harnessFlags };
}
