// Single source of truth for the "what the screen showed the user" provenance the
// model reads for grounding, plus the offline detector that flags when the agent
// fabricates an on-screen surface.
//
// WHY THIS EXISTS
// pipeline_status / pipeline_widget rows are things the DETERMINISTIC layer put on
// the user's screen (a status line, a shortlist, a picker) — the agent did NOT
// write them. They're persisted as assistant-role ChatMessage rows for the UI, but
// the model must not see them as its own prior prose, or it imitates the format and
// confabulates a fake role list / picker it never showed.
//
// So on replay (loadSessionMessages) we render each one as a real `role:"system"`
// message — a non-assistant channel the model reads as operator context, never as
// its own turn. Keeping them OFF the assistant channel is the whole mechanism; an
// assistant-authored envelope, however tagged, is what gets imitated. DeepSeek
// (the sole runtime provider) accepts mid-array system messages on its
// Anthropic-compatible endpoint. Caveat if HANK_MODEL ever moves to Claude: this
// replay path needs a model that accepts a mid-array system role — Opus 4.8 does,
// claude-sonnet-4-6 does not.
//
// The detector below is the OFFLINE backstop the audit harnesses run over every
// assistant turn: a HARD tripwire for the one operator marker the agent must never
// emit (`<system-reminder>`, forbidden by hank/system.ts and never injected by
// this path), plus FUZZY shapes that imitate a widget in prose.

import type Anthropic from "@anthropic-ai/sdk";

// Render a "this was shown to the user" note as a message the model reads for
// grounding but must never author. A real `role:"system"` message — a non-assistant
// channel so it can't be mistaken for the agent's own prose (see the file header).
// `noteText` is the human-readable record (built by loadSessionMessages).
export function buildProvenanceMessage(
  noteText: string,
): Anthropic.MessageParam {
  // DeepSeek's endpoint accepts a mid-array system role; the Anthropic SDK types
  // only model user/assistant, so cast (mirrors withDeepseekRequestDefaults).
  return {
    role: "system",
    content: [{ type: "text", text: noteText }],
  } as unknown as Anthropic.MessageParam;
}

type FabricationReason = {
  // Stable id so audits can dedup / categorize across turns.
  id: string;
  // "hard" = an operator marker that should NEVER appear in fresh assistant output
  // (100% precision — always a bug). "fuzzy" = a shape that imitates an on-screen
  // widget; high but not perfect precision, so it's report-only.
  tier: "hard" | "fuzzy";
  // Human-readable explanation + the snippet that matched.
  note: string;
  match: string;
};

// Operator framings the agent must never emit. Provenance now rides a plain
// `role:"system"` message with no distinctive tag, so we no longer INJECT a
// `<system-reminder>` marker — but hank/system.ts still forbids the agent from
// emitting one (models know the marker from training and can produce it
// spontaneously). If it shows up in a freshly-generated assistant turn, the agent
// wrote a system record as its own prose — always a confabulation bug, so this
// stays a HARD tripwire regardless of what we inject.
const HARD_PATTERNS: Array<{ id: string; re: RegExp; note: string }> = [
  {
    id: "system_reminder_echo",
    re: /<\/?system-reminder\b/i,
    note: "emitted the <system-reminder> operator marker (a system record wrapper, never agent prose)",
  },
];

// Shapes that imitate an on-screen widget (role menu / shortlist / picker).
// Report-only — an agent could in rare cases legitimately produce something
// similar, so these flag for review rather than asserting a hard failure.
const FUZZY_PATTERNS: Array<{ id: string; re: RegExp; note: string }> = [
  {
    id: "recommends_applying_legend",
    re: /✓\s*=\s*.*recommend/i,
    note: 'drew a widget legend ("✓ = recommends applying")',
  },
  {
    id: "which_roles_header",
    re: /which roles (at .+ )?(should you|do you want to) (apply|work)/i,
    note: 'wrote an on-screen picker header ("Which roles should you apply to?")',
  },
  {
    id: "tap_skip_chrome",
    re: /\btap\s+["“]?skip\b/i,
    note: 'wrote widget button chrome ("Tap Skip …")',
  },
  {
    id: "checkmark_role_menu",
    // Two+ lines shaped like "1. ✓ Some Role" / "✓ Some Role" — the fabricated
    // numbered/checkmarked role menu. Requires repetition to avoid firing on a
    // single incidental "✓ done" line.
    re: /(^|\n)\s*(?:\d+\.\s*)?✓\s+\S.*(?:\n.*){0,3}(\n)\s*(?:\d+\.\s*)?✓\s+\S/,
    note: "rendered a checkmarked/numbered role menu in prose",
  },
];

// Scan a freshly-generated assistant turn's TEXT for reproductions of
// system-rendered UI. Pass only the agent's authored text blocks (never the
// replayed provenance notes themselves, which would self-trigger).
export function detectFabricatedUiRender(text: string): {
  hit: boolean;
  hardHit: boolean;
  reasons: FabricationReason[];
} {
  const reasons: FabricationReason[] = [];
  for (const p of HARD_PATTERNS) {
    const m = text.match(p.re);
    if (m)
      reasons.push({
        id: p.id,
        tier: "hard",
        note: p.note,
        match: m[0].trim().slice(0, 80),
      });
  }
  for (const p of FUZZY_PATTERNS) {
    const m = text.match(p.re);
    if (m)
      reasons.push({
        id: p.id,
        tier: "fuzzy",
        note: p.note,
        match: m[0].trim().slice(0, 80),
      });
  }
  return {
    hit: reasons.length > 0,
    hardHit: reasons.some((r) => r.tier === "hard"),
    reasons,
  };
}
