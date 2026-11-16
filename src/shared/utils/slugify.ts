// Canonical slugifier — the one copy, for memory paths and Company.slug alike.
// The two shapes differ only by option: bare kebab (lowercase → non-alnum→"-" →
// trim) is the default; company slugs add URL-stripping and a length cap.

type SlugifyOpts = {
  // Strip a leading http(s):// and www. before slugifying (company URLs).
  stripUrl?: boolean;
  // Hard length cap; trailing hyphens re-trimmed after the slice.
  maxLength?: number;
};

export function slugify(input: string, opts: SlugifyOpts = {}): string {
  let s = input.toLowerCase();
  if (opts.stripUrl) s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (opts.maxLength && s.length > opts.maxLength) {
    s = s.slice(0, opts.maxLength).replace(/-+$/g, "");
  }
  return s;
}

const MAX_SLUG_LEN = 80;

// Cap an already-built slug to MAX_SLUG_LEN, re-trimming any trailing hyphen the
// slice exposes. Unlike slugify() it does NOT re-process the string — the input
// is already a slug (possibly with a location / department / numeric suffix the
// minter appended).
export function capSlug(s: string): string {
  return s.length > MAX_SLUG_LEN
    ? s.slice(0, MAX_SLUG_LEN).replace(/-+$/g, "")
    : s;
}

// A cuid (Prisma @default(cuid())) is ~25 lowercase-alnum chars, no hyphens, and
// starts with "c". Our slugs are lowercase-alnum-plus-hyphen. The two namespaces
// overlap only for a hyphen-free single-word slug (e.g. "stripe"), which is why
// resolvers try the slug lookup first and fall back to id — this predicate is a
// cheap hint, never the sole arbiter.
export function looksLikeCuid(s: string): boolean {
  return /^c[a-z0-9]{20,}$/.test(s) && !s.includes("-");
}
