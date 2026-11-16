// String shaping that knows nothing about what the string holds.

// Clips to at most `max` characters INCLUDING the ellipsis, so the result never
// overflows a budget the caller sized (a prompt slice, a fixed-width label).
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Fold for equality/dedup comparisons: lowercase, collapse runs of whitespace,
// trim. Used wherever two human-typed strings must match as "the same text"
// despite casing or line-wrapping differences (application-question dedup, the
// draft/critique item lookups).
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// First character, uppercased — the monogram/avatar fallback shown when there's
// no logo or profile image. "?" when the string is blank.
export function initial(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
}

// Clips from the FRONT, keeping the tail — for opaque identifiers where the
// end is the distinguishing part (a push endpoint, a key, a URL).
export function truncateStart(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}

// Indents every line by `spaces` — for nesting a block of text inside a
// prompt or a log entry without disturbing its internal line breaks.
export function indent(s: string, spaces = 4): string {
  const pad = " ".repeat(spaces);
  return s
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

// "acme-corp" / "acme_corp" → "Acme Corp". The display-name fallback when a
// slug is the only name available.
export function titleCaseSlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// A short all-letters string that reads as an initialism ("IBM", "SpaceX"),
// where a substring match would be too loose to be meaningful.
export function looksLikeAcronym(s: string): boolean {
  return /^[A-Za-z]{2,6}$/.test(s.trim());
}
