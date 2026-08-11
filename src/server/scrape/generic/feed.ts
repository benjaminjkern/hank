// XML job feeds → plain objects, so everything downstream (the job-shape
// detector, the field mapper, the recipe runner) treats them exactly like a
// JSON list and needs no second code path.
//
// Covers the two shapes that actually show up: RSS/Atom (`<item>` / `<entry>`)
// and the bespoke per-vendor feeds that predate JSON APIs (Personio's `/xml`
// serves `<position>` blocks). Rather than special-casing vendors, we find the
// repeated element — the tag that appears many times and contains child
// elements — which is what an item feed IS regardless of what it names its rows.
//
// Deliberately not a real XML parser: no namespaces, no attributes, no
// validation. A feed too gnarly for this is a board that has earned a provider
// file.

import { decodeEntities } from "@/utils/html";

// Wrapper tags that hold the items rather than being one. Without this the
// scanner would happily decide the whole document is a two-item list.
const CONTAINER_TAGS = new Set([
  "rss",
  "feed",
  "channel",
  "urlset",
  "sitemapindex",
  "root",
  "response",
  "data",
]);

const MIN_ITEMS = 2;
const MAX_ITEMS = 5000;

export function parseFeedItems(xml: string): Record<string, unknown>[] | null {
  const tag = dominantItemTag(xml);
  if (!tag) return null;
  const items: Record<string, unknown>[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  for (const m of xml.matchAll(re)) {
    const record = childFields(m[1]);
    if (Object.keys(record).length > 0) items.push(record);
    if (items.length >= MAX_ITEMS) break;
  }
  return items.length >= MIN_ITEMS ? items : null;
}

// The repeated, child-bearing element with the most occurrences. Ties go to the
// deeper-nested tag, which is the item rather than its container.
function dominantItemTag(xml: string): string | null {
  const counts = new Map<string, number>();
  for (const m of xml.matchAll(/<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/g)) {
    const tag = m[1].toLowerCase();
    if (CONTAINER_TAGS.has(tag)) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best: { tag: string; count: number } | null = null;
  for (const [tag, count] of counts) {
    if (count < MIN_ITEMS) continue;
    // An item wraps other elements; a leaf like <title> repeats just as often
    // but has nothing inside it.
    if (!hasChildElements(xml, tag)) continue;
    if (best == null || count > best.count) best = { tag, count };
  }
  return best?.tag ?? null;
}

function hasChildElements(xml: string, tag: string): boolean {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  return m != null && /<[a-zA-Z]/.test(m[1]);
}

// Flatten one item's children into a record. A child with its own children
// contributes its text content — good enough for a feed, and it keeps the
// record flat so the key-name heuristics work unchanged.
function childFields(inner: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of inner.matchAll(
    /<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g,
  )) {
    // Namespace prefixes carry no meaning for us and break key matching
    // (`content:encoded` → `encoded`).
    const key = m[1].toLowerCase().split(":").pop() ?? m[1];
    const value = cleanText(m[2]);
    if (!value) continue;
    // A repeated child (multiple <category>) becomes a comma list rather than
    // last-wins.
    const existing = out[key];
    out[key] = typeof existing === "string" ? `${existing}, ${value}` : value;
  }
  return out;
}

function cleanText(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Nested markup inside a description is content, not structure — leave the
  // tags for the recipe's html-to-text transform to strip, so a caller that
  // wants the markup can still have it.
  return decodeEntities(withoutCdata).trim();
}
