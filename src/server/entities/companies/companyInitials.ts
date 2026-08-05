// A company name's word-initials, for acronym-aware lookup. A bare substring
// filter misses "AWS" ⊂ "Amazon Web Services" (no shared substring), so a
// pre-create check came back empty and Hank created a duplicate stub. A caller
// pairs this with `looksLikeAcronym` to ALSO surface companies whose initials
// match — advisory only (Hank/the user still decide), per "heuristics advise,
// don't override".
//
// The stopword list is what makes this company-specific rather than a generic
// initialism: corporate suffixes and filler words don't contribute a letter.
const COMPANY_NAME_STOPWORDS = new Set([
  "of",
  "the",
  "and",
  "for",
  "a",
  "an",
  "&",
  "com",
  "inc",
  "labs",
  "ai",
]);

export function companyInitials(name: string): string {
  return name
    .replace(/[.,/()]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !COMPANY_NAME_STOPWORDS.has(w.toLowerCase()))
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
