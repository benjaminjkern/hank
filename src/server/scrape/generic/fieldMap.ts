// Turn a detected job-shaped array into a runnable BoardRecipe.
//
// This is what makes the deterministic probe pay for itself twice: the same
// pass that proves a board is readable also emits the plan for reading it
// again, so persisting the result turns a 20-candidate fan-out into one fetch —
// and the emitted recipe is the artifact a human reads when deciding the board
// deserves a provider file.
//
// sourceUrl gets its own ladder here rather than being mapped like any other
// field, because it is `Job.sourceUrl @unique` — the global dedupe key. A wrong
// title is a cosmetic bug; a wrong URL template permanently orphans rows and
// can hand a posting to the wrong company. So an identity column that isn't
// already a URL yields NO recipe from this module: buildUrlTemplate has to be
// verified against live pages first (genericProbe.ts owns that step).

import { absoluteUrl } from "../recipe/fields";

import { asText, nestedTextKey, type JobArrayMatch } from "./jobShape";

import type {
  BoardRecipe,
  FieldSpec,
  ListSource,
  Transform,
} from "../recipe/types";

// A path into the item, descending one level when the value is a nested object
// whose text leaf we know how to find (`location: {city: "Berlin"}`).
function pathSpec(
  key: string,
  items: Record<string, unknown>[],
  transform?: Transform[],
): FieldSpec {
  const sample = items.find((i) => i[key] != null)?.[key];
  const leaf = nestedTextKey(sample);
  const path = leaf ? `${key}.${leaf}` : key;
  // Arrays of one are ubiquitous in this layer ("locations": ["Remote"]);
  // join-comma handles both that and the genuinely-multi case.
  const needsJoin = Array.isArray(sample);
  const transforms = [
    ...(needsJoin ? (["join-comma"] as const) : []),
    ...(transform ?? []),
  ];
  return transforms.length > 0
    ? { path, transform: [...transforms] }
    : { path };
}

// Whether the description column holds markup — decides html-to-text.
function looksLikeHtml(items: Record<string, unknown>[], key: string): boolean {
  for (const item of items.slice(0, 5)) {
    const s = asText(item[key]);
    if (s && /<\/?(p|div|br|ul|li|h[1-6])\b/i.test(s)) return true;
  }
  return false;
}

export type UrlPlan =
  // The identity column already holds a usable URL.
  | { kind: "direct"; spec: FieldSpec }
  // It holds an id/slug that has to be interpolated — CALLER MUST VERIFY the
  // resulting URLs resolve before trusting this.
  | { kind: "template"; spec: FieldSpec; template: string; samples: string[] }
  | { kind: "none" };

// Derive how a posting's URL is built. `boardUrl` anchors relative paths and
// supplies the origin a template is guessed against.
export function planSourceUrl(match: JobArrayMatch, boardUrl: string): UrlPlan {
  const { identity, identityIsUrl } = match.keys;
  const values = match.items
    .map((i) => asText(i[identity]))
    .filter((s): s is string => s != null);
  if (values.length === 0) return { kind: "none" };

  if (identityIsUrl) {
    const absolute = values.every((v) => /^https?:\/\//i.test(v));
    return {
      kind: "direct",
      spec: absolute
        ? { path: identity }
        : { path: identity, transform: ["abs-url"] },
    };
  }

  // An opaque id. Guess the detail path from the board URL's own shape — a
  // board at /careers usually details at /careers/{id} — and let the caller
  // prove it.
  const base = boardUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const template = `${base}/{${identity}}`;
  const samples = values
    .slice(0, 2)
    .map((v) => absoluteUrl(`${base}/${v}`, boardUrl))
    .filter((s): s is string => s != null);
  if (samples.length === 0) return { kind: "none" };
  return { kind: "template", spec: { template }, samples, template };
}

// Assemble the recipe. `sourceUrl` is passed in rather than derived because the
// caller is the only one that can have verified a template.
export function buildRecipe(args: {
  list: ListSource;
  itemsPath: string;
  match: JobArrayMatch;
  sourceUrl: FieldSpec;
  familyKey?: string;
}): BoardRecipe {
  const items = args.match.items;
  const k = args.match.keys;

  const fields: BoardRecipe["fields"] = {
    title: pathSpec(k.title, items),
    sourceUrl: args.sourceUrl,
  };
  if (k.description) {
    fields.rawContent = pathSpec(
      k.description,
      items,
      looksLikeHtml(items, k.description) ? ["html-to-text"] : undefined,
    );
  }
  if (k.location) fields.location = pathSpec(k.location, items);
  if (k.department) fields.department = pathSpec(k.department, items);
  if (k.compensation) fields.compensation = pathSpec(k.compensation, items);
  if (k.employmentType)
    fields.employmentType = pathSpec(k.employmentType, items);

  return {
    version: 1,
    list: args.list,
    itemsPath: args.itemsPath,
    fields,
    ...(args.familyKey ? { familyKey: args.familyKey } : {}),
  };
}

// A board whose list rows carry no body needs a detail strategy. The probe
// can't know the detail page's shape without fetching one, so this is the
// conservative default: pull the posting page and take its JSON-LD JobPosting
// if present, else its text. Both are addressed through `detail.*`.
export function withJsonLdDetail(recipe: BoardRecipe): BoardRecipe {
  return {
    ...recipe,
    detail: { extract: { kind: "jsonld", atType: "JobPosting" } },
    fields: {
      ...recipe.fields,
      rawContent: {
        path: "detail.0.description",
        transform: ["html-to-text"],
      },
    },
  };
}

// The universal fallback when a detail page publishes no structured data.
// Unlike withTextDetail it also supplies the TITLE, which is the difference
// between working and not for a sitemap-sourced board — those list rows are
// bare URLs, so every field they have comes from the detail page.
export function withPageDetail(recipe: BoardRecipe): BoardRecipe {
  // Only take the page's title when the list rows didn't have one. A list-row
  // title is the better source — a posting page's <h1> is often the company's
  // banner rather than the role.
  const titleFromDetail =
    "path" in recipe.fields.title &&
    recipe.fields.title.path.startsWith("detail");
  return {
    ...recipe,
    detail: { extract: { kind: "page" } },
    fields: {
      ...recipe.fields,
      ...(titleFromDetail ? { title: { path: "detail.title" } } : {}),
      rawContent: { path: "detail.text" },
    },
  };
}

// Body only — for a board whose list rows already carry a good title.
export function withTextDetail(recipe: BoardRecipe): BoardRecipe {
  return {
    ...recipe,
    detail: { extract: { kind: "text" } },
    fields: { ...recipe.fields, rawContent: { path: "detail" } },
  };
}
