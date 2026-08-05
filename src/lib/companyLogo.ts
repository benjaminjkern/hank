// Best-effort company favicon URL derivation.
//
// Companies' careers URLs often live on ATS subdomains (jobs.lever.co/foo,
// boards.greenhouse.io/foo). Asking Google for the favicon of those gives the
// ATS's logo, not the company's. For known ATS patterns we extract the slug
// and guess `{slug}.com`; otherwise we use the URL's hostname. The guess
// fails when the ATS slug ≠ real domain ("cognition" on Ashby → cognition.com,
// which isn't Cognition Labs). The agent can override per company via
// `Company.logoUrl`; we honor that first, then fall back to the derivation.
//
// Google's favicon service serves whatever favicon the site advertises. Most
// companies set a reasonable one — for the rest the UI falls back to a
// monogram chip on image load error.

import { urlHost } from "@/utils/url";

const ATS_PATTERNS: Array<RegExp> = [
  /^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)/i,
  /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i,
  /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i,
  /^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i,
  /^https?:\/\/api\.lever\.co\/v0\/postings\/([^/?#]+)/i,
  /^https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i,
];

// Source URL is nullable on the Company schema — a stub Company can exist
// before the hunter has resolved a careers URL. When both override and
// sourceUrl are missing, return an empty string so the UI's image-load error
// fallback (monogram chip) kicks in.
export function companyLogoUrl(
  sourceUrl: string | null,
  override?: string | null,
): string {
  if (override && override.length > 0) return override;
  if (!sourceUrl) return "";
  const domain = deriveCompanyDomain(sourceUrl);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function deriveCompanyDomain(sourceUrl: string): string {
  for (const re of ATS_PATTERNS) {
    const m = sourceUrl.match(re);
    if (m) return `${m[1]}.com`;
  }
  return urlHost(sourceUrl) ?? sourceUrl;
}
