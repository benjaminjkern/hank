import type { NegotiationPanel } from "@/shared/panelMode";

// How the chip names one surface: its glyph, the stage it belongs to, what its
// changes are counted in, and what to call them in a screen-reader label. One
// row per panel rather than a record per field, so a fourth surface is one entry
// and can't be added to three tables and missed in the fourth.
export const PANEL_CHIP: Record<
  NegotiationPanel,
  { icon: string; stage: string; unit: string; noun: string }
> = {
  "shortlist-board": {
    icon: "◧",
    stage: "Shortlist",
    unit: "mark",
    noun: "shortlist",
  },
  discovery: { icon: "⌕", stage: "Companies", unit: "mark", noun: "company" },
  application: {
    icon: "✎",
    stage: "Application",
    unit: "edit",
    noun: "application",
  },
};

// "Application · SRE @ Stripe — 2 edits". Three facts, in the order they answer
// the user's question: which stage of the work, which company/role, how much.
// A count on its own left them guessing which of three screens (and which
// company) the × would throw away, and the instructions that used to make up
// the difference cost more room than the answer does.
//
// `scope` comes off the viewed payload the count came from, so the two are as
// fresh as each other by construction; null where the surface has no single
// subject (discovery is the whole proposed list) or where nothing is loaded.
export function panelEditLabel(
  panel: NegotiationPanel,
  count: number,
  scope: string | null,
): string {
  const { stage } = PANEL_CHIP[panel];
  const head = scope ? `${stage} · ${scope}` : stage;
  return `${head} — ${panelEditCount(panel, count)}`;
}

// Just the amount, for the armed state — the chip named its subject a moment
// ago and only one chip arms at a time, so re-stating it there is a long line
// asking a short question.
export function panelEditCount(panel: NegotiationPanel, count: number): string {
  const { unit } = PANEL_CHIP[panel];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
