// A BoardRecipe is a declarative plan for reading ONE job board that no wired
// provider recognizes: where the postings live, how to walk them, and which key
// or selector holds each field. It is data, never code — the runner
// (runRecipe.ts) is the only thing that executes, so a recipe can't reach the
// network on its own, can't be eval'd, and can't skip an invariant.
//
// Two producers, one shape: the deterministic probe infers a recipe for free
// (scrape/generic/), and the board_recipe sub-agent authors one for boards the
// probe can't crack. Neither ever emits a job — they emit this, and the runner
// fetches. That is what makes a hallucinated posting structurally impossible.
//
// NO RECIPE FIELD IS EVER COMPILED AS A PATTERN, deliberately. Every locator is
// a path, a selector, or an identifier: paths and templates are split on literal
// characters, and the selector engine in fields.ts narrows tag / class / id /
// attribute names to `[\w-]` before they reach a RegExp and matches everything
// else by literal containment. An LLM-authored regex would add a ReDoS surface
// and a whole class of silently-wrong matches for nothing — which is why the
// `assignment` blob kind takes a variable NAME and the runner owns the
// balanced-brace scan that finds its value.
//
// The expressiveness ceiling is intentional. A board that needs faceted POST
// paging (Workday), GraphQL with introspection disabled (Gem), or an XHR only a
// rendered browser fires has earned a hand-written provider under ats/providers/
// — and a recipe that can't express it is the signal, not a failure.

// Where the list of postings comes from.
export type ListSource =
  // A JSON (or JSON-ish) endpoint returning the postings directly.
  | {
      kind: "json";
      url: string;
      method?: "GET" | "POST";
      // Verbatim request body for POST. Not templated — paging rewrites the
      // URL's query string, never the body, so a body-paged API is out of
      // scope by construction (that's a provider file's job).
      body?: string;
      headers?: Record<string, string>;
    }
  // Fetch an HTML page and pull a JSON blob out of it — the single most common
  // shape on the long tail, because every SSR framework ships its data this way.
  | { kind: "embedded"; url: string; blob: EmbeddedBlob }
  // Repeated DOM rows. Last resort among the HTML shapes: class names churn far
  // faster than data keys do. Rows are matched HTML, not objects, so their
  // fields use `selector` specs — a `path` or `template` spec has nothing to
  // read against until a detail fetch merges one in.
  | { kind: "html"; url: string; rowSelector: string }
  // An RSS/Atom/vendor XML feed. Rows are flattened to plain objects by
  // generic/feed.ts, so their fields are addressed by `path` exactly like JSON.
  | { kind: "feed"; url: string }
  // A sitemap whose <loc> entries ARE the postings. Carries no fields of its
  // own, so a `detail` strategy is mandatory — validate.ts enforces that.
  //
  // `pathPrefix` is what keeps a multi-tenant host honest: a sitemap lives at
  // the ORIGIN, but on a VC/accelerator job board one path is one company and
  // the sitemap covers every other company too. It must be part of the RECIPE,
  // not just of discovery — a stored plan that carried only `pathContains`
  // re-broadened on execution and pulled a sibling company's postings, having
  // "verified" cleanly on a narrower set.
  | { kind: "sitemap"; url: string; pathContains: string; pathPrefix?: string };

export type EmbeddedBlob =
  // <script id="__NEXT_DATA__" type="application/json">{…}</script>
  | { kind: "script-id"; id: string }
  // window.__NUXT__ = {…} / window.pageData = {…}. `varName` is an identifier;
  // the runner scans forward from it for a balanced JSON value.
  | { kind: "assignment"; varName: string }
  // React Server Components flight rows: self.__next_f.push([1,"…"]).
  | { kind: "flight" }
  // JSON parked in an attribute — Inertia's data-page, Recruitee's data-props.
  | { kind: "attribute"; selector: string; attr: string }
  // <script type="application/ld+json"> carrying schema.org JobPosting objects.
  | { kind: "jsonld"; atType: "JobPosting" };

// How to read ONE field off one posting. The variants are position-dependent:
// `path` reads a JSON item, `selector` reads a DOM row, and `template`
// interpolates other fields of the same item (`{slug}`) — which is how a board
// that only publishes an id still yields a URL.
export type FieldSpec =
  | { path: string; transform?: Transform[] }
  | { selector: string; attr?: string; transform?: Transform[] }
  | { template: string; transform?: Transform[] }
  | { literal: string };

export type Transform =
  | "trim"
  | "html-to-text"
  | "decode-entities"
  // Array → comma-joined string. Boards routinely publish locations and
  // departments as arrays of one.
  | "join-comma"
  // Array → first element, kept as-is (vs join-comma, which flattens).
  | "first"
  // Resolve a relative href against the board URL.
  | "abs-url";

// Query-string paging only — see ListSource.json's `body` note.
export type Paging =
  | { kind: "page-param"; param: string; start: number; maxPages: number }
  | { kind: "offset-param"; param: string; size: number; maxPages: number }
  | { kind: "cursor"; cursorPath: string; param: string; maxPages: number }
  // The response states its own total, so the runner knows when to stop AND
  // whether the board was truncated. Strongest of the four.
  | { kind: "total-count"; totalPath: string; param: string; size: number };

// How to get whatever the list didn't carry — usually the body, sometimes the
// structured fields too (a sitemap list carries only URLs).
//
// The extracted value is merged onto the item under the key `detail`, so field
// specs address it by ordinary path: `{path:"detail.description"}`,
// `{path:"detail.0.title"}` for a JSON-LD array. That's why there's no
// `bodyPath` here — one merge point beats a second addressing scheme, and it
// lets a detail page supply the title as easily as the body.
export type DetailStrategy = {
  // Interpolates the item's fields (`{slug}`). Omit to fetch the item's own
  // resolved sourceUrl, which is the common case.
  urlTemplate?: string;
  extract:
    | { kind: "json"; path?: string }
    // The whole response as HTML-stripped text. The bluntest option and often
    // the right one for a prose body.
    | { kind: "text" }
    // `{title, text}` — the two things every posting page has, however it's
    // built. The universal fallback when a detail page publishes no structured
    // data, and the only extract that can supply a TITLE, which is what a
    // sitemap-sourced board needs (its list rows are bare URLs).
    | { kind: "page" }
    | { kind: "selector"; selector: string }
    | EmbeddedBlob;
};

export type BoardRecipe = {
  version: 1;
  list: ListSource;
  // Dot path from the list payload to the postings array. "" = the payload IS
  // the array. Numeric segments index (`data.0.jobs`).
  itemsPath: string;
  fields: {
    title: FieldSpec;
    sourceUrl: FieldSpec;
    rawContent?: FieldSpec;
    location?: FieldSpec;
    department?: FieldSpec;
    compensation?: FieldSpec;
    employmentType?: FieldSpec;
  };
  // Read off the first item, or the page, when the board names itself. The
  // caller falls back to the Company row's name, so this is a nicety.
  companyName?: FieldSpec;
  paging?: Paging;
  detail?: DetailStrategy;
  // The board genuinely publishes no body anywhere (mirrors ats/providers/meta.ts).
  // Relaxes the rawContent length floor in validate.ts — it does NOT skip the
  // check, because "no body" still has to be a deliberate claim.
  listOnly?: boolean;
  // Coarse technique family — "wp-job-manager", "recruitee", "nextdata". Not
  // used at runtime; it's the grouping key that answers "which board software
  // shows up often enough to deserve a provider file?" on /admin/board-readers.
  familyKey?: string;
};

// What a runner/probe run reports back about the recipe itself, for the reader
// row's health tracking. Kept separate from ScrapedCompany because it describes
// the READ, not the board.
export type RecipeRunStats = {
  listRequests: number;
  detailRequests: number;
  detailFailures: number;
};
