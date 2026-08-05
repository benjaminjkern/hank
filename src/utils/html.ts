// HTML text handling. Two decoders live here on purpose — they differ in
// entity ORDER, and the order is the whole point:
//
//   • unescapeHtml undoes escapeHtml, so it must decode `&amp;` LAST. Decoding
//     it first would turn an escaped `&amp;lt;` into a real `<` and let an
//     entity in the source text break out of the markup it was escaped for.
//   • decodeEntities is the lenient scraper decoder and decodes `&amp;` FIRST
//     — deliberately, because some ATS boards double-encode their HTML
//     (`&amp;lt;div&amp;gt;`) and htmlToText runs it twice to unwrap that.
//
// Use the escape/unescape pair for text you produced; use decodeEntities for
// text a third party produced.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Flatten an HTML fragment to readable plain text: block tags become newlines,
// list items get a "- " bullet, style/script contents are dropped, runs of
// whitespace collapse.
export function htmlToText(html: string): string {
  if (!html) return "";
  // Decode entities first — some providers (Greenhouse) double-encode their
  // HTML, so the source is literally `&lt;div&gt;`. Without decoding first, the
  // tag-stripping regex sees no real tags. Run decode twice to catch nested
  // encodings (e.g. `&amp;lt;` → `&lt;` → `<`).
  return decodeEntities(decodeEntities(html))
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
