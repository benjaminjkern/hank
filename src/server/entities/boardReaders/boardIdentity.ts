// Does this board actually belong to this company?
//
// The invariant a learned reader has to satisfy before it's stored, and the one
// thing that catches an AGGREGATOR — a site listing roles at many employers,
// where every structural check passes because the postings really do live on
// that host, under that path, with distinct URLs and real titles. A recipe
// built on one files other companies' jobs under yours and scrapes cleanly
// forever. (Observed: a company resolved to `worklatam.com/jobs` and returned
// roles at Next Level, Hype and Vice, and a dozen other employers.)
//
// A wired provider needs none of this — its board URL is the company's board by
// construction. This is only for boards we INFERRED, where nothing else has
// checked whose they are.
//
// The signal is that a real board says whose it is, in the host or the path:
//   careers.betches.com          → "betches"
//   liner.com/careers/jobs       → "liner"
//   jenniejohnson.com/company/the-female-quotient → "female", "quotient"
//   worklatam.com/jobs           → nothing. That's the tell.
//
// Postings on a recognized ATS are exempt: a company fronting Ashby or
// Greenhouse legitimately has its roles on a host that never mentions it.

import { detectAts } from "@/server/scrape/ats";

// Generic words that identify no one. A company called "Media" or "Labs" would
// match half the internet, so they can't carry the identification on their own.
const GENERIC_TOKENS = new Set([
  "the",
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "company",
  "co",
  "group",
  "holdings",
  "media",
  "labs",
  "lab",
  "technologies",
  "technology",
  "tech",
  "systems",
  "software",
  "solutions",
  "services",
  "global",
  "international",
  "ventures",
  "studio",
  "studios",
  "digital",
  "agency",
  "partners",
  "team",
  "jobs",
  "careers",
  "hiring",
  "work",
  "talent",
]);

// Short fragments collide with anything ("ai" is in "worklatam"), so a token
// has to be substantial enough that its presence means something.
const MIN_TOKEN_CHARS = 4;

export type BoardIdentityCheck = { ok: true } | { ok: false; reason: string };

export function boardIdentifiesCompany(args: {
  companyName: string;
  boardUrl: string;
  // A sample of the postings the reader produced. A posting on a recognized ATS
  // means the company fronts a real board, which identifies it well enough.
  sampleJobUrls?: string[];
}): BoardIdentityCheck {
  if ((args.sampleJobUrls ?? []).some((u) => detectAts(u))) return { ok: true };

  const tokens = identifyingTokens(args.companyName);
  // Nothing usable to match on — a company named entirely from generic words.
  // Refusing here would reject it forever on a technicality it can't fix.
  if (tokens.length === 0) return { ok: true };

  const haystack = normalize(args.boardUrl);
  if (tokens.some((t) => haystack.includes(t))) return { ok: true };

  return {
    ok: false,
    reason: `the board at ${args.boardUrl} doesn't name ${args.companyName} anywhere in its host or path (looked for ${tokens.join(", ")}), which is what a shared job board or aggregator looks like — its postings would be other companies'`,
  };
}

export function identifyingTokens(companyName: string): string[] {
  return normalizeWords(companyName).filter(
    (w) => w.length >= MIN_TOKEN_CHARS && !GENERIC_TOKENS.has(w),
  );
}

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Strip everything a URL uses as punctuation so a hyphenated slug
// (`/the-female-quotient`) still contains the plain token (`quotient`).
function normalize(url: string): string {
  return url.toLowerCase().replace(/[^a-z0-9]/g, "");
}
