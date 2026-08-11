// Pulling JSON out of an HTML page. Every SSR framework ships its page data as
// a blob in the markup, so this is the single highest-yield generic technique:
// the board's own API response is usually sitting in the HTML already, fully
// structured, no rendering required.
//
// Two entry points, same extractors: `extractBlob` reads ONE named blob for a
// stored recipe, `harvestBlobs` pulls EVERY blob it can find so the probe can
// hunt them for a job-shaped array. Pure and synchronous — callers supply the
// HTML.

import { isRecord } from "@/utils/guards";
import { decodeEntities } from "@/utils/html";
import { tryParseJson } from "@/utils/json";

import type { EmbeddedBlob } from "../recipe/types";

// Assignment targets worth harvesting blind. Ordered most-common first; a
// recipe can name any identifier, this list only drives discovery.
const KNOWN_STATE_VARS = [
  "__NUXT__",
  "__remixContext",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__APOLLO_STATE__",
  "__staticRouterHydrationData",
  "pageData",
  "__INITIAL_DATA__",
  "__APP_STATE__",
  "__NEXT_DATA__",
];

// Attributes that carry a whole JSON payload (Inertia, Recruitee, Stimulus).
const KNOWN_JSON_ATTRS = ["data-page", "data-props", "data-state", "data-json"];

export type HarvestedBlob = {
  // How a recipe would address this blob again.
  spec: EmbeddedBlob;
  // Human label for the recon prompt's evidence block.
  label: string;
  value: unknown;
  // Serialized size of the source text, for the evidence budget.
  bytes: number;
};

// -- single-blob read (recipe execution) -------------------------------------

export function extractBlob(html: string, spec: EmbeddedBlob): unknown {
  switch (spec.kind) {
    case "script-id":
      return scriptById(html, spec.id);
    case "assignment":
      return extractAssignedJson(html, spec.varName);
    case "flight":
      return flightPayload(html);
    case "attribute":
      return attributeJson(html, spec.selector, spec.attr);
    case "jsonld":
      return jsonLdOfType(html, spec.atType);
  }
}

// -- discovery (probe + recon evidence) --------------------------------------

export function harvestBlobs(html: string): HarvestedBlob[] {
  const out: HarvestedBlob[] = [];
  const push = (
    spec: EmbeddedBlob,
    label: string,
    value: unknown,
    bytes: number,
  ) => {
    if (value == null) return;
    out.push({ spec, label, value, bytes });
  };

  for (const { id, text } of jsonScripts(html)) {
    const value = tryParseJson(text);
    if (id) {
      push(
        { kind: "script-id", id },
        `<script id="${id}">`,
        value,
        text.length,
      );
    } else if (value != null) {
      // Unnamed JSON scripts can't be re-addressed by a recipe, but they still
      // count as evidence, and the ld+json ones are addressable via `jsonld`.
      push(
        { kind: "jsonld", atType: "JobPosting" },
        "<script type=application/json> (unnamed)",
        value,
        text.length,
      );
    }
  }

  for (const varName of KNOWN_STATE_VARS) {
    const raw = assignedJsonText(html, varName);
    if (raw == null) continue;
    push(
      { kind: "assignment", varName },
      `${varName} = …`,
      tryParseJson(raw),
      raw.length,
    );
  }

  const flight = flightPayload(html);
  if (flight != null) {
    push({ kind: "flight" }, "self.__next_f flight rows", flight, 0);
  }

  for (const attr of KNOWN_JSON_ATTRS) {
    for (const { selector, text } of attributeJsonCandidates(html, attr)) {
      push(
        { kind: "attribute", selector, attr },
        `${selector}[${attr}]`,
        tryParseJson(text),
        text.length,
      );
    }
  }

  const ld = jsonLdOfType(html, "JobPosting");
  if (ld != null) {
    push({ kind: "jsonld", atType: "JobPosting" }, "ld+json JobPosting", ld, 0);
  }

  return out;
}

// -- extractors --------------------------------------------------------------

// `<script id="x" type="application/json">` and friends. Only JSON-typed
// scripts: an ordinary <script> body is code, not a payload, and the assignment
// scanner below is the right tool for those.
function jsonScripts(html: string): Array<{ id: string | null; text: string }> {
  const out: Array<{ id: string | null; text: string }> = [];
  for (const m of html.matchAll(
    /<script([^>]*type\s*=\s*["'](?:application\/json|application\/ld\+json)["'][^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    const idMatch = /\sid\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    out.push({ id: idMatch ? idMatch[1] : null, text: m[2].trim() });
  }
  return out;
}

function scriptById(html: string, id: string): unknown {
  for (const s of jsonScripts(html)) {
    if (s.id === id) return tryParseJson(s.text);
  }
  return null;
}

// Balanced forward scan from `varName = ` to the end of its JSON value. String-
// literal aware, so a brace inside a description doesn't end the value early.
// A regex can't do this — the value is arbitrarily nested — and that is the
// reason the recipe format stores a variable NAME rather than a pattern.
export function extractAssignedJson(html: string, varName: string): unknown {
  const raw = assignedJsonText(html, varName);
  return raw == null ? null : tryParseJson(raw);
}

// Recipe input reaches a RegExp here, so restrict it to what a JS identifier
// path can legally contain rather than trying to escape it.
const IDENTIFIER_RE = /^[A-Za-z_$][\w$.]*$/;

function assignedJsonText(html: string, varName: string): string | null {
  if (!IDENTIFIER_RE.test(varName)) return null;
  const needle = new RegExp(`${varName.replace(/\./g, "\\.")}\\s*=\\s*`, "g");
  for (const m of html.matchAll(needle)) {
    const start = (m.index ?? 0) + m[0].length;
    const opener = html[start];
    if (opener !== "{" && opener !== "[") continue;
    const value = sliceBalanced(html, start);
    if (value) return value;
  }
  return null;
}

// Walk from an opening brace/bracket to its match, skipping over string
// literals (and their escapes) so braces inside prose don't count.
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString: '"' | "'" | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// React Server Components stream their payload as `self.__next_f.push([1,"…"])`
// rows whose strings concatenate into one document. We return every JSON value
// we can recover from the joined text — the payload is a bespoke wire format,
// not JSON, so precise parsing isn't available and isn't needed: the probe only
// needs to find the postings array inside it.
function flightPayload(html: string): unknown {
  const chunks: string[] = [];
  for (const m of html.matchAll(
    /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*"([\s\S]*?)"\s*\]\s*\)/g,
  )) {
    chunks.push(m[1]);
  }
  if (chunks.length === 0) return null;
  // The rows are JS string literals; round-trip each through JSON.parse to undo
  // its escaping before joining.
  const joined = chunks
    .map((c) => {
      const unescaped = tryParseJson(`"${c}"`);
      return typeof unescaped === "string" ? unescaped : c;
    })
    .join("");
  const values: unknown[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch !== "{" && ch !== "[") continue;
    const slice = sliceBalanced(joined, i);
    if (!slice || slice.length < 80) continue;
    const parsed = tryParseJson(slice);
    if (parsed != null) {
      values.push(parsed);
      i += slice.length - 1;
    }
  }
  return values.length > 0 ? values : null;
}

function attributeJsonCandidates(
  html: string,
  attr: string,
): Array<{ selector: string; text: string }> {
  if (!/^[\w:-]+$/.test(attr)) return [];
  const out: Array<{ selector: string; text: string }> = [];
  const re = new RegExp(
    `<(\\w+)([^>]*\\s${attr}\\s*=\\s*"([^"]*)"[^>]*)>`,
    "gi",
  );
  for (const m of html.matchAll(re)) {
    out.push({
      selector: `${m[1].toLowerCase()}[${attr}]`,
      text: decodeEntities(m[3]),
    });
  }
  return out;
}

function attributeJson(html: string, selector: string, attr: string): unknown {
  for (const c of attributeJsonCandidates(html, attr)) {
    if (c.selector === selector) return tryParseJson(c.text);
  }
  return null;
}

// Every schema.org node of the requested @type, flattened out of the shapes
// ld+json is published in: a bare object, an array, or an @graph wrapper.
export function jsonLdOfType(html: string, atType: string): unknown[] | null {
  const found: unknown[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!isRecord(node)) return;
    const graph = node["@graph"];
    if (graph != null) visit(graph);
    const type = node["@type"];
    const matches = Array.isArray(type)
      ? type.includes(atType)
      : type === atType;
    if (matches) found.push(node);
  };
  for (const s of jsonScripts(html)) visit(tryParseJson(s.text));
  return found.length > 0 ? found : null;
}
