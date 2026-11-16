// Human-readable renderers for numbers. Presentation only — nothing here
// decides anything, and nothing here knows what the number counts.

// USD with precision that scales down to per-call LLM costs — a single cheap
// turn is a fraction of a cent, and rounding it to $0.00 hides the whole
// admin cost surface.
export function money(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Thousands separators in the viewer's locale — for counts big enough that
// the raw digits are hard to scan (token totals, row counts).
export function count(n: number): string {
  return n.toLocaleString();
}
