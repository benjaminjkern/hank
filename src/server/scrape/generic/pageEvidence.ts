// What recon reads instead of the page.
//
// A careers page is routinely 300KB of HTML wrapping a 400-character answer.
// Sending that to a model is the expensive way to fail: it blows the context,
// buries the signal, and invites the model to transcribe postings instead of
// describing where they live. So we send a TABLE OF CONTENTS — every JSON blob
// as a structural OUTLINE (key names, types, one truncated sample value), the
// distinct URL-ish literals, a DOM skeleton of the repeated structure, and what
// the deterministic probe already tried.
//
// The outline is the whole trick: `props.pageProps.jobs[] (142) { id:number,
// title:string("Senior Backend Engineer"), slug:string(…) }` is ~400 chars and
// contains literally everything needed to author the field mapping, from a blob
// that was 300KB.
//
// This does I/O, so it is NOT part of the sub-agent def (a def's userContent is
// pure and synchronous). The caller — procedures/registry/reconBoard/ — builds
// it and hands it in.

import { isRecord } from "@/utils/guards";
import { truncate } from "@/utils/text";

import { fetchText } from "../ats/shared";
import { htmlHeaders } from "../recipe/runRecipe";

import { harvestBlobs } from "./blobs";
import { scriptUrlCandidates } from "./genericProbe";
import { fetchRobots, sitemapLocs } from "./sitemap";

const FETCH_TIMEOUT_MS = 10_000;
// Per-section budgets. The total is what keeps a recon turn affordable; the
// split is what stops one enormous blob from crowding out the DOM skeleton.
const BUDGET = {
  blobs: 3_000,
  scriptUrls: 1_000,
  dom: 4_000,
  head: 600,
};
const MAX_SAMPLE_CHARS = 40;
const MAX_OUTLINE_KEYS = 25;
const MAX_OUTLINE_DEPTH = 4;

export type PageEvidence = {
  url: string;
  // Whether the page could be fetched at all. False is itself the finding — a
  // 403 on a plain fetch usually means bot protection, not a missing board.
  fetched: boolean;
  probeReport: string;
  blobOutlines: string;
  scriptUrls: string;
  domSkeleton: string;
  headLinks: string;
  sitemapSummary: string;
};

export async function buildPageEvidence(
  url: string,
  probeTried: string[],
): Promise<PageEvidence> {
  const res = await fetchText(
    url,
    { headers: htmlHeaders() },
    FETCH_TIMEOUT_MS,
  );
  const probeReport =
    probeTried.length > 0
      ? probeTried.map((t) => `- ${t}`).join("\n")
      : "- (not run)";

  if (!res.ok) {
    return {
      url,
      fetched: false,
      probeReport,
      blobOutlines: `(page fetch failed: ${res.error})`,
      scriptUrls: "",
      domSkeleton: "",
      headLinks: "",
      sitemapSummary: await sitemapSummary(url),
    };
  }

  const html = res.text;
  return {
    url,
    fetched: true,
    probeReport,
    blobOutlines: renderBlobOutlines(html),
    scriptUrls: renderScriptUrls(html, url),
    domSkeleton: renderDomSkeleton(html),
    headLinks: renderHeadLinks(html),
    sitemapSummary: await sitemapSummary(url),
  };
}

// -- blob outlines ------------------------------------------------------------

function renderBlobOutlines(html: string): string {
  const blobs = harvestBlobs(html);
  if (blobs.length === 0) return "(no JSON blobs found in the page)";
  const parts: string[] = [];
  let used = 0;
  for (const blob of blobs) {
    const spec = JSON.stringify(blob.spec);
    const outline = outlineOf(blob.value, 0);
    const block = `## ${blob.label}\naddress: ${spec}\n${outline}`;
    if (used + block.length > BUDGET.blobs) {
      parts.push(`(${blobs.length - parts.length} more blobs omitted)`);
      break;
    }
    used += block.length;
    parts.push(block);
  }
  return parts.join("\n\n");
}

// A structural sketch: key names, value types, and one truncated sample per
// leaf. Arrays print their length and outline their FIRST element only — the
// shape is what matters, and every row of a board has the same one.
function outlineOf(value: unknown, depth: number, path = ""): string {
  const indent = "  ".repeat(depth);
  if (depth > MAX_OUTLINE_DEPTH) return `${indent}…`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}${path}[] (empty)`;
    const head = `${indent}${path}[] (${value.length})`;
    const inner = outlineOf(value[0], depth + 1);
    return `${head}\n${inner}`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, MAX_OUTLINE_KEYS);
    const lines = shown.map((k) => {
      const v = value[k];
      if (Array.isArray(v) || isRecord(v)) return outlineOf(v, depth + 1, k);
      return `${"  ".repeat(depth + 1)}${k}: ${describeScalar(v)}`;
    });
    const more =
      keys.length > shown.length
        ? [`${"  ".repeat(depth + 1)}… ${keys.length - shown.length} more keys`]
        : [];
    const head = path ? `${indent}${path}:` : `${indent}{`;
    return [head, ...lines, ...more].join("\n");
  }
  return `${indent}${path}: ${describeScalar(value)}`;
}

function describeScalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return `string(${JSON.stringify(truncate(v, MAX_SAMPLE_CHARS))})`;
  }
  if (typeof v === "number") return `number(${v})`;
  if (typeof v === "boolean") return `boolean(${String(v)})`;
  return typeof v;
}

// -- the other sections -------------------------------------------------------

function renderScriptUrls(html: string, boardUrl: string): string {
  const urls = scriptUrlCandidates(html, boardUrl);
  if (urls.length === 0) return "(no API-ish URLs in inline scripts)";
  const lines = urls.map((u) => `- ${u}`).join("\n");
  return lines.length > BUDGET.scriptUrls
    ? `${lines.slice(0, BUDGET.scriptUrls)}\n…`
    : lines;
}

// Find the deepest element whose children repeat with a stable class signature
// — a list of postings looks like this whatever framework drew it — and print
// the group plus one truncated sample row. This is what makes an `html` recipe
// authorable without seeing the page.
function renderDomSkeleton(html: string): string {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const m of html.matchAll(
    /<(li|article|tr|div|a)\b([^>]*class\s*=\s*"([^"]+)"[^>]*)>/gi,
  )) {
    const tag = m[1].toLowerCase();
    const classes = m[3]
      .split(/\s+/)
      .filter((c) => c && !/\d{3,}|^css-|^sc-/.test(c))
      .slice(0, 3)
      .join(".");
    if (!classes) continue;
    const key = `${tag}.${classes}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, {
        count: 1,
        sample: truncate(html.slice(m.index ?? 0, (m.index ?? 0) + 400), 400),
      });
    }
  }
  const repeated = [...groups.entries()]
    .filter(([, g]) => g.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6);
  if (repeated.length === 0) return "(no repeated DOM structure detected)";

  let out = "";
  for (const [selector, group] of repeated) {
    const block = `${selector} × ${group.count}\n  sample: ${group.sample.replace(/\s+/g, " ")}\n`;
    if (out.length + block.length > BUDGET.dom) break;
    out += block;
  }
  return out.trim();
}

function renderHeadLinks(html: string): string {
  const lines: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel\s*=\s*["'](alternate|canonical)["']/i.test(m[0])) {
      lines.push(`- ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>/gi)) {
    if (/(job|career|vacan|opening|position)/i.test(m[1])) {
      lines.push(`- href ${m[1]}`);
    }
    if (lines.length > 20) break;
  }
  const text = lines.slice(0, 20).join("\n");
  return text.length > BUDGET.head ? `${text.slice(0, BUDGET.head)}\n…` : text;
}

async function sitemapSummary(url: string): Promise<string> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return "(unparseable URL)";
  }
  const robots = await fetchRobots(origin);
  const target = robots.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const res = await fetchText(
    target,
    { headers: { Accept: "application/xml,*/*" } },
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) return `no readable sitemap at ${target}`;
  const locs = sitemapLocs(res.text);
  if (locs.length === 0) return `${target}: no <loc> entries`;
  // Group by first path segment so "340 of these look like /jobs/<slug>" is
  // visible without listing 1,400 URLs.
  const buckets = new Map<string, number>();
  for (const loc of locs) {
    try {
      const seg = new URL(loc).pathname.split("/").filter(Boolean)[0] ?? "/";
      buckets.set(seg, (buckets.get(seg) ?? 0) + 1);
    } catch {
      /* skip unparseable */
    }
  }
  const top = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([seg, n]) => `/${seg} (${n})`)
    .join(", ");
  return `${target}: ${locs.length} URLs — ${top}${
    robots.disallow.length > 0
      ? `\nrobots.txt disallows: ${robots.disallow.slice(0, 6).join(", ")}`
      : ""
  }`;
}
