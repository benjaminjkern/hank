// Memory path conventions:
//   profile.md
//   frequent_questions.md
//   resume.md
//   companies/{slug}.md        (slug = Company.slug)
//   jobs/{slug}.md             (slug = Job.slug — a human-readable slug, never a cuid)
//   opportunities/{slug}.md    (slug = Opportunity.slug — a human-readable slug, never a cuid)
//   contacts/{slug}.md         (slug = kebab-case derived from Contact.name)
//   daily/{YYYY-MM-DD}.md
//   weekly/{YYYY-WW}.md
//
// `profile.md` is EVERYTHING durable about the user — thesis, constraints, voice,
// patterns. Don't split it back into a "direction" note and a "constraints" note:
// that shape had no separable job (every consumer read both in one Promise.all
// and concatenated them, and both grew their own `## Dealbreakers` and
// `## Shortlist guardrails`), and it needed a precedence rule to arbitrate them —
// which is the tell that two files can hold the same fact. `resume.md` stays
// separate because it answers a different question: profile.md is what the user
// WANTS and how to frame them, resume.md is the raw facts of what they've
// actually done. Every uploaded résumé is merged into it.
//
// NO ids are ever shown to the agent — every entity is addressed by its slug
// (they're easy to get wrong as cuids). The regexes stay permissive enough to
// also match a legacy cuid path so pre-migration rows still resolve; resolveFK
// (store.ts) accepts slug-or-id when populating the FK column.
//
// Paths are addressed by the agent as strings; storage is rows on MemoryNote
// keyed by (userId, path). When a path matches a Company/Job/Opportunity/Contact
// convention we also populate the FK columns for cascade + fast lookup.

const COMPANY_RE = /^companies\/([a-z0-9-]+)\.md$/;
const JOB_RE = /^jobs\/([A-Za-z0-9_-]+)\.md$/;
const OPPORTUNITY_RE = /^opportunities\/([A-Za-z0-9_-]+)\.md$/;
const CONTACT_RE = /^contacts\/([a-z0-9-]+)\.md$/;
const DAILY_RE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/;
const WEEKLY_RE = /^weekly\/\d{4}-W\d{2}\.md$/;
const FLAT_NAMES = new Set([
  "profile.md",
  "frequent_questions.md",
  "resume.md",
]);

type PathInfo =
  | { kind: "flat"; path: string }
  | { kind: "company"; path: string; slug: string }
  // `slug` is the Job/Opportunity slug (or a legacy cuid for un-migrated
  // rows); resolveFK accepts either when looking up the FK id.
  | { kind: "job"; path: string; slug: string }
  | { kind: "opportunity"; path: string; slug: string }
  | { kind: "contact"; path: string; slug: string }
  | { kind: "daily"; path: string }
  | { kind: "weekly"; path: string };

export function validatePath(path: string): PathInfo {
  if (
    !path ||
    path.includes("..") ||
    path.startsWith("/") ||
    path.includes("\\")
  ) {
    throw new Error(`invalid memory path: ${path}`);
  }
  if (FLAT_NAMES.has(path)) return { kind: "flat", path };
  const company = COMPANY_RE.exec(path);
  if (company) return { kind: "company", path, slug: company[1] };
  const job = JOB_RE.exec(path);
  if (job) return { kind: "job", path, slug: job[1] };
  const opportunity = OPPORTUNITY_RE.exec(path);
  if (opportunity) return { kind: "opportunity", path, slug: opportunity[1] };
  const contact = CONTACT_RE.exec(path);
  if (contact) return { kind: "contact", path, slug: contact[1] };
  if (DAILY_RE.test(path)) return { kind: "daily", path };
  if (WEEKLY_RE.test(path)) return { kind: "weekly", path };
  throw new Error(
    `unrecognized memory path: ${path}. Allowed: profile.md, frequent_questions.md, resume.md, companies/{slug}.md, jobs/{slug}.md, opportunities/{slug}.md, contacts/{name-slug}.md, daily/{YYYY-MM-DD}.md, weekly/{YYYY-WW}.md`,
  );
}

// Kebab-case slugifier for contacts/{slug}.md. Re-exported from the canonical
// slugifier (src/server/platform/slug); the no-option default is byte-identical
// to the previous local implementation.
export { slugify } from "@/server/platform/slug/slugify";
