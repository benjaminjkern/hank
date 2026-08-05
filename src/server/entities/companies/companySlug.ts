// Company.slug derivation — URL-aware (strips a leading careers URL a user might
// paste as the "name") + 64-char cap. The single company-slug helper (was a
// third `slugify` wrapper in tools/lib/watchlist.ts); delegates to the canonical
// slugifier, behavior preserved via options.

import { slugify } from "@/server/platform/slug/slugify";

export function companySlug(name: string): string {
  return slugify(name, { stripUrl: true, maxLength: 64 });
}
