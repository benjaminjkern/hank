// Paging for the `list_*` tools: the page math and the two agent-facing strings
// that go with it, in one place.
//
// Composition, not inheritance of behavior — a tool supplies a `count` and a
// windowed `rows` query (usually one entity-level list function each), and gets
// back the resolved page plus the sentences. The domain half stays in
// `entities/`, which is why this file names no entity.
//
// The strings matter as much as the arithmetic: seven hand-written copies had
// already drifted into four phrasings of "there are more pages", and the model
// only learns to pass `page:2` if the same sentence tells it to every time.

// One page size for every list tool. It exists to keep a result token-bounded —
// a watchlist of 400 companies must not blow out Hank's context in one call —
// which is a property of the CHANNEL, not of any entity, so all of them share it.
const TOOL_PAGE_SIZE = 30;

// What a windowed query needs. Deliberately plain numbers: `entities/` cannot
// import from the tool layer, so the list functions declare `skip`/`take`
// themselves rather than depending on a type from here.
export type PageWindow = { skip: number; take: number };

export type Paged<T> = {
  rows: T[];
  total: number;
  pageNum: number;
  totalPages: number;
};

// Resolve a requested page against a count, then fetch just that window. A page
// past the end skips the fetch — `total` is already enough to phrase the error,
// and it's what tells a caller "empty list" apart from "page 9 of 3".
export async function paginate<T>(
  page: number | undefined,
  query: {
    count: () => Promise<number>;
    rows: (window: PageWindow) => Promise<T[]>;
  },
): Promise<Paged<T>> {
  const pageNum = page && page > 0 ? Math.floor(page) : 1;
  const total = await query.count();
  const totalPages = Math.ceil(total / TOOL_PAGE_SIZE);
  if (total === 0 || pageNum > totalPages) {
    return { rows: [], total, pageNum, totalPages };
  }
  const rows = await query.rows({
    skip: (pageNum - 1) * TOOL_PAGE_SIZE,
    take: TOOL_PAGE_SIZE,
  });
  return { rows, total, pageNum, totalPages };
}

// True when the agent asked for a page that doesn't exist AND some do. An empty
// list is not this case — "no companies match" is the tool's own sentence, and
// telling the model to "request page 1–0" instead would be nonsense.
export function isPastLastPage(p: Paged<unknown>): boolean {
  return p.total > 0 && p.pageNum > p.totalPages;
}

// `noun` is the plural ("companies", "events", "roles") — these only ever
// describe a set of 2+, since a single-page result never reaches either string.
export function pastLastPageMessage(p: Paged<unknown>, noun: string): string {
  return `(page ${p.pageNum} is past the last page — ${p.total} ${noun} across ${p.totalPages} page${p.totalPages === 1 ? "" : "s"}; request page 1–${p.totalPages})`;
}

// The "there's more" footer, or "" on a single-page result. Trailing newlines
// included so a caller can append it unconditionally.
export function pageFooter(p: Paged<unknown>, noun: string): string {
  if (p.totalPages <= 1) return "";
  const more =
    p.pageNum < p.totalPages ? ` — pass page:${p.pageNum + 1} for more` : "";
  return `\n\n(page ${p.pageNum} of ${p.totalPages}; ${p.total} ${noun} total${more})`;
}
