// Word-level diff of two prose passages.
//
// `diffWords` is the comparison; `renderWordDiff` is one way to show it
// (unified inline markers, unchanged runs elided). They're separate because the
// counts are useful on their own — a caller deciding "light edit vs total
// rewrite" reads the ratios rather than the string.
//
// Tokenization is whitespace-only, so punctuation rides with its word and a
// re-wrapped paragraph doesn't register as a change. That makes this right for
// prose and wrong for code.

export type DiffSegment = {
  kind: "same" | "add" | "remove";
  text: string;
};

export type WordDiff = {
  segments: DiffSegment[];
  sameWords: number;
  addedWords: number;
  removedWords: number;
};

// Beyond this many differing words on either side, the quadratic LCS isn't
// worth its memory — the passages have diverged far enough that "all of this
// became all of that" is the honest summary anyway.
const MAX_LCS_TOKENS = 1500;

function tokenize(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export function diffWords(before: string, after: string): WordDiff {
  const a = tokenize(before);
  const b = tokenize(after);

  // Shared head and tail come off first: an edit to one paragraph of a letter
  // usually leaves almost everything matched, which is what keeps the LCS below
  // small enough to be free.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const middle =
    midA.length > MAX_LCS_TOKENS || midB.length > MAX_LCS_TOKENS
      ? wholesaleReplace(midA, midB)
      : lcsDiff(midA, midB);

  const segments: DiffSegment[] = [];
  if (head > 0)
    segments.push({ kind: "same", text: a.slice(0, head).join(" ") });
  segments.push(...middle);
  if (tail > 0) {
    segments.push({ kind: "same", text: a.slice(a.length - tail).join(" ") });
  }

  return {
    segments: mergeAdjacent(segments),
    sameWords: head + tail + countWords(middle, "same"),
    addedWords: countWords(middle, "add"),
    removedWords: countWords(middle, "remove"),
  };
}

function wholesaleReplace(a: string[], b: string[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  if (a.length > 0) out.push({ kind: "remove", text: a.join(" ") });
  if (b.length > 0) out.push({ kind: "add", text: b.join(" ") });
  return out;
}

function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }

  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      out.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

function mergeAdjacent(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === seg.kind) prev.text = `${prev.text} ${seg.text}`;
    else out.push({ ...seg });
  }
  return out;
}

function countWords(
  segments: DiffSegment[],
  kind: DiffSegment["kind"],
): number {
  return segments
    .filter((s) => s.kind === kind)
    .reduce((n, s) => n + tokenize(s.text).length, 0);
}

export type RenderWordDiffOptions = {
  // Unchanged words kept on each side of a change so a marker reads in context.
  context?: number;
  // Cap on the rendered string; anything past it is dropped with an ellipsis.
  maxLength?: number;
};

// Unified inline rendering: removals in [-…-], additions in {+…+}, long
// untouched stretches collapsed to "…". Readable by a person and unambiguous
// to a model, which is the whole requirement — nothing parses this back.
export function renderWordDiff(
  diff: WordDiff,
  opts: RenderWordDiffOptions = {},
): string {
  const context = opts.context ?? 6;
  const maxLength = opts.maxLength ?? 1200;

  const parts = diff.segments.map((seg, idx) => {
    if (seg.kind === "add") return `{+${seg.text}+}`;
    if (seg.kind === "remove") return `[-${seg.text}-]`;
    const words = tokenize(seg.text);
    if (words.length <= context * 2 + 1) return seg.text;
    // The very start and end of the passage have a change on one side only, so
    // they only need context on that side.
    const isFirst = idx === 0;
    const isLast = idx === diff.segments.length - 1;
    if (isFirst) return `… ${words.slice(-context).join(" ")}`;
    if (isLast) return `${words.slice(0, context).join(" ")} …`;
    return `${words.slice(0, context).join(" ")} … ${words.slice(-context).join(" ")}`;
  });

  const rendered = parts.join(" ");
  return rendered.length > maxLength
    ? `${rendered.slice(0, maxLength).trimEnd()}…`
    : rendered;
}
