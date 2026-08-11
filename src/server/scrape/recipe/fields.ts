// Reading one FieldSpec off one posting. Pure and synchronous — no fetches, no
// DOM library, no regex compiled from recipe input. Everything here is either a
// literal string match or an index walk, which is what keeps an LLM-authored
// recipe from being an execution surface.

import { isRecord } from "@/utils/guards";
import { decodeEntities, htmlToText } from "@/utils/html";

import type { FieldSpec, Transform } from "./types";

// Walk a dot path. Numeric segments index arrays (`data.0.jobs`); "" returns the
// root, which is how a payload that IS the postings array is addressed.
export function readPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cur: unknown = root;
  for (const segment of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (!isRecord(cur)) return undefined;
    cur = cur[segment];
  }
  return cur;
}

// Coerce whatever a path landed on into a string. Arrays and objects are left
// for the transforms to flatten — a raw `[object Object]` would be worse than
// nothing, so they come back null instead.
function toText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function applyTransforms(
  value: unknown,
  transforms: Transform[] | undefined,
  baseUrl: string,
): string | null {
  let cur = value;
  for (const t of transforms ?? []) {
    switch (t) {
      case "first":
        cur = Array.isArray(cur) ? cur[0] : cur;
        break;
      case "join-comma":
        cur = Array.isArray(cur)
          ? cur.map(toText).filter(Boolean).join(", ")
          : cur;
        break;
      case "html-to-text": {
        const s = toText(cur);
        cur = s == null ? cur : htmlToText(s);
        break;
      }
      case "decode-entities": {
        const s = toText(cur);
        cur = s == null ? cur : decodeEntities(s);
        break;
      }
      case "trim": {
        const s = toText(cur);
        cur = s == null ? cur : s.trim();
        break;
      }
      case "abs-url": {
        const s = toText(cur);
        cur = s == null ? cur : absoluteUrl(s, baseUrl);
        break;
      }
    }
  }
  // An untransformed array of one is the single commonest long-tail shape
  // (`"locations": ["Remote"]`), so collapse it rather than dropping the field.
  if (Array.isArray(cur) && cur.length === 1) cur = cur[0];
  const out = toText(cur);
  return out == null || out.trim() === "" ? null : out.trim();
}

export function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// Interpolate `{path}` placeholders against the item. A placeholder that
// resolves to nothing voids the whole template — a URL with a literal `{slug}`
// left in it is worse than no URL, because it would persist as a real
// Job.sourceUrl and never resolve.
function fillTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const out = template.replace(/\{([^{}]+)\}/g, (_m, path: string) => {
    const v = toText(readPath(item, path.trim()));
    if (v == null || v === "") {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}

// `htmlRow` is the raw HTML of the current row, supplied only for `html` list
// sources; a selector spec against a JSON item has nothing to match and yields
// null rather than throwing.
export function readField(
  spec: FieldSpec | undefined,
  item: unknown,
  baseUrl: string,
  htmlRow?: string,
): string | null {
  if (!spec) return null;
  if ("literal" in spec) return spec.literal;
  if ("template" in spec) {
    const filled = fillTemplate(spec.template, item);
    if (filled == null) return null;
    return applyTransforms(filled, spec.transform, baseUrl);
  }
  if ("path" in spec) {
    return applyTransforms(readPath(item, spec.path), spec.transform, baseUrl);
  }
  if (htmlRow == null) return null;
  const picked = selectFromRow(htmlRow, spec.selector, spec.attr);
  return applyTransforms(picked, spec.transform, baseUrl);
}

// -- the tiny selector engine -------------------------------------------------
//
// A deliberate ~50 lines instead of a DOM library. It supports exactly what a
// job row needs — tag, .class, #id, [attr], and descendant chains ("li a.title")
// — because the recipe format only ever needs to locate a cell inside a row
// whose boundaries the caller already found. Anything hairier than this is a
// board that has earned a provider file.
//
// Matching is literal string containment on the attribute text, so no pattern
// from a recipe is ever compiled.

type SimpleSelector = {
  tag: string | null;
  classes: string[];
  id: string | null;
  attrs: string[];
};

function parseSimple(part: string): SimpleSelector {
  const sel: SimpleSelector = { tag: null, classes: [], id: null, attrs: [] };
  let rest = part;
  for (const m of rest.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    sel.attrs.push(m[2] ? `${m[1]}=${m[2]}` : m[1]);
  }
  rest = rest.replace(/\[[^\]]*\]/g, "");
  const idMatch = /#([\w-]+)/.exec(rest);
  if (idMatch) sel.id = idMatch[1];
  for (const m of rest.matchAll(/\.([\w-]+)/g)) sel.classes.push(m[1]);
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tagMatch) sel.tag = tagMatch[1].toLowerCase();
  return sel;
}

// Every element whose open tag matches, with its inner HTML. Void elements
// (img, input, br) have no closing tag, so they come back with empty inner
// content rather than swallowing the rest of the document.
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export type MatchedElement = { openTag: string; inner: string; outer: string };

export function findElements(
  html: string,
  selector: string,
  limit = 500,
): MatchedElement[] {
  const parts = selector.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  let scopes: MatchedElement[] = [{ openTag: "", inner: html, outer: html }];
  for (const part of parts) {
    const sel = parseSimple(part);
    const next: MatchedElement[] = [];
    for (const scope of scopes) {
      next.push(...matchWithin(scope.inner, sel, limit - next.length));
      if (next.length >= limit) break;
    }
    scopes = next;
    if (scopes.length === 0) return [];
  }
  return scopes;
}

function matchWithin(
  html: string,
  sel: SimpleSelector,
  limit: number,
): MatchedElement[] {
  if (limit <= 0) return [];
  const out: MatchedElement[] = [];
  const tagPattern = sel.tag ?? "[a-zA-Z][\\w-]*";
  const openRe = new RegExp(`<(${tagPattern})(\\s[^>]*)?>`, "gi");
  for (const m of html.matchAll(openRe)) {
    const tag = m[1].toLowerCase();
    const attrText = m[2] ?? "";
    if (!attrsMatch(attrText, sel)) continue;
    const openTag = m[0];
    const start = (m.index ?? 0) + openTag.length;
    const inner = VOID_TAGS.has(tag) ? "" : sliceToClose(html, tag, start);
    out.push({
      openTag,
      inner,
      outer: `${openTag}${inner}`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function attrsMatch(attrText: string, sel: SimpleSelector): boolean {
  const lower = attrText.toLowerCase();
  if (sel.id != null && !lower.includes(`id="${sel.id.toLowerCase()}"`)) {
    return false;
  }
  for (const cls of sel.classes) {
    if (!hasClass(attrText, cls)) return false;
  }
  for (const attr of sel.attrs) {
    const [name, value] = attr.split("=");
    if (value == null) {
      if (!lower.includes(`${name.toLowerCase()}=`)) return false;
    } else if (
      !lower.includes(`${name.toLowerCase()}="${value.toLowerCase()}"`)
    ) {
      return false;
    }
  }
  return true;
}

// Whole-token class match — `.job` must not match `class="job-filter-bar"`.
function hasClass(attrText: string, cls: string): boolean {
  const m = /class\s*=\s*["']([^"']*)["']/i.exec(attrText);
  if (!m) return false;
  return m[1].split(/\s+/).includes(cls);
}

// Balanced scan to the matching close tag, so nested same-tag elements (a <div>
// inside a <div>) don't end the slice early.
function sliceToClose(html: string, tag: string, from: number): string {
  const re = new RegExp(`<(/?)(${tag})(\\s[^>]*)?>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

function selectFromRow(
  rowHtml: string,
  selector: string,
  attr: string | undefined,
): string | null {
  // A row's own attributes are addressable: `readField({selector:"", attr:"href"})`
  // would be ambiguous, so `:scope` names the row itself.
  if (selector === ":scope") {
    return attr ? attrValue(rowHtml, attr) : htmlToText(rowHtml);
  }
  const found = findElements(rowHtml, selector, 1)[0];
  if (!found) return null;
  return attr ? attrValue(found.openTag, attr) : htmlToText(found.inner);
}

function attrValue(openTag: string, attr: string): string | null {
  const re = new RegExp(
    `\\s${escapeForAttr(attr)}\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const m = re.exec(openTag);
  return m ? decodeEntities(m[1]) : null;
}

// `attr` comes from a recipe, so it reaches a RegExp — restrict it to the
// characters an HTML attribute name can legally hold instead of escaping.
function escapeForAttr(attr: string): string {
  return attr.replace(/[^\w:-]/g, "");
}
