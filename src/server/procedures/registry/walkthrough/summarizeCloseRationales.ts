// Collapse a company's per-job close-summary labels into ONE clause naming what
// was actually set aside — so a company where a walkthrough surfaced nothing
// gets a specific, defensible account ("12 were sales roles, 3 were product
// roles, and 2 were in Europe") instead of a vague "none line up."
//
// The input is the structured `closeSummaryLabel` the pre-scan/scan sub-agent
// emits per skip — a clean 2-4 word phrase ("sales roles", "in Europe", "too
// senior"), NOT free text to reverse-engineer. So this is a plain tally, and it
// reports every group it has.
//
// It reports COUNTS and never a bare category, because the caller renders this
// after "I went through their N open roles" — and a summary that names one
// reason there reads as a claim about ALL of them. That was wrong in exactly the
// case that matters: a company whose roles were mostly the wrong function but
// where a handful were the right job in the wrong city. Those few are the ones
// worth revisiting, and dropping them is how "they're all sales roles" gets said
// about a board that had good roles in it.

// Beyond this, the tail is counted rather than listed — a nine-way breakdown is
// a wall of text nobody reads, and the long tail is where the labels get noisy.
const MAX_GROUPS = 4;

export function summarizeCloseRationales(labels: string[]): string | null {
  const tally = new Map<string, number>();
  for (const raw of labels) {
    const label = raw.trim().replace(/\s+/g, " ");
    if (label.length >= 3) tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;

  // "N were <label>" rather than "N <label>", because the labels aren't all
  // noun phrases — "in Europe" and "too senior" only read as English with the
  // verb, and it's also what keeps a group of one from saying "1 sales roles".
  const shown = ranked.slice(0, MAX_GROUPS);
  const parts = shown.map(([label, n]) => `${n} were ${label}`);
  const remainder = ranked.slice(MAX_GROUPS).reduce((sum, [, n]) => sum + n, 0);
  if (remainder > 0) parts.push(`${remainder} were out for other reasons`);

  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
