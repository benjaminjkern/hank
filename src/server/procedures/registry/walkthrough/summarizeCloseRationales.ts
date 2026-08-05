// Collapse a company's per-job close-summary labels into ONE clause the company
// arm slots after "they're …" — so a company where a walkthrough surfaced
// nothing gets a specific, defensible reason ("they're sales, product, and
// recruiting roles") instead of a vague "none line up."
//
// The input is the structured `closeSummaryLabel` the pre-scan/scan sub-agent
// emits per skip — a clean 2-4 word phrase ("sales roles", "in Europe", "too
// senior"), NOT free text to reverse-engineer. So this is a plain tally + list
// format, nothing more. Closes without a label (older rows, non-scan closes)
// aren't passed in; an empty list returns null and the caller falls back to the
// generic message.

// A role-shaped label ends in "role"/"roles"; only these merge into a list
// ("sales, product, and recruiting roles"). Heterogeneous labels don't compose,
// so a mix just uses the dominant one.
const ROLE_TAIL = /\s+roles?$/i;

export function summarizeCloseRationales(labels: string[]): string | null {
  const tally = new Map<string, number>();
  for (const raw of labels) {
    const label = raw.trim().replace(/\s+/g, " ");
    if (label.length >= 3) tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;

  const total = ranked.reduce((sum, [, n]) => sum + n, 0);
  // One label dominates → say it plainly rather than listing near-duplicates.
  if (ranked.length === 1 || ranked[0][1] / total >= 0.6) return ranked[0][0];

  // Otherwise name the top few — but only when they're all role-shaped, which
  // lists cleanly; a heterogeneous mix falls back to the dominant label.
  const top = ranked.slice(0, 3).map(([label]) => label);
  if (!top.every((p) => ROLE_TAIL.test(p))) return ranked[0][0];
  const heads = top.map((p) => p.replace(ROLE_TAIL, "").trim());
  if (heads.some((h) => h.length < 2)) return ranked[0][0];
  const list =
    heads.length === 2
      ? `${heads[0]} and ${heads[1]}`
      : `${heads.slice(0, -1).join(", ")}, and ${heads[heads.length - 1]}`;
  return `${list} roles`;
}
