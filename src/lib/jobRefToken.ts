// `<job-ref jobId="X" label="..."/>` is an inline chat-message token that
// renders as a clickable chip pointing at a specific JobInteraction. The
// canonical form lives inside user/assistant text (Anthropic content blocks
// can't carry custom segment kinds), so we keep the token in the message
// text and split it out at render time.
//
// The label is captured at send time and embedded in the token, so chips
// stay readable even after the linked job is renamed or hard-deleted, and
// the renderer never has to fetch.

// The parser only produces text and job-ref pieces — tool segments are
// outside its concern. Narrowing here lets render-side switch statements
// stay exhaustive without a tool fallthrough.
type JobRefTokenPiece =
  | { kind: "text"; text: string }
  | { kind: "job-ref"; jobId: string; label: string };

// jobId is a cuid (`c…` + alphanumeric); we match conservatively so
// well-formed real ids parse and arbitrary user-typed `<job-ref/>` doesn't
// (the regex still allows reasonable cuid variation without locking to a
// specific length).
const JOB_REF_PATTERN =
  /<job-ref\s+jobId="([A-Za-z0-9_-]+)"\s+label="([^"]*)"\s*\/>/g;

// Label round-trips through HTML entity escaping so quotes/angle brackets in
// job titles can't break out of the attribute syntax. Keep the set minimal —
// the renderer only escapes the characters that would break the parser.
function encodeJobRefLabel(label: string): string {
  return label
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeJobRefLabel(label: string): string {
  return label
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function formatJobRefToken(jobId: string, label: string): string {
  return `<job-ref jobId="${jobId}" label="${encodeJobRefLabel(label)}"/>`;
}

// Split a string around `<job-ref/>` tokens into a flat JobRefTokenPiece[] of text
// pieces and job-ref chips. Returns a single text segment (possibly empty)
// when no tokens are present, so callers can render uniformly. Adjacent
// text pieces are preserved as-is — no merging, since the original spacing
// around tokens carries meaning ("I submitted ✓ " has a trailing space the
// chip needs to sit next to).
export function splitJobRefTokens(text: string): JobRefTokenPiece[] {
  if (!text.includes("<job-ref")) {
    return [{ kind: "text", text }];
  }
  const out: JobRefTokenPiece[] = [];
  let lastIdx = 0;
  // Reset lastIndex via matchAll's iterator behavior — safe since the regex
  // has the `g` flag and matchAll yields fresh state.
  for (const match of text.matchAll(JOB_REF_PATTERN)) {
    const [whole, jobId, encodedLabel] = match;
    const start = match.index ?? 0;
    if (start > lastIdx) {
      out.push({ kind: "text", text: text.slice(lastIdx, start) });
    }
    out.push({
      kind: "job-ref",
      jobId,
      label: decodeJobRefLabel(encodedLabel),
    });
    lastIdx = start + whole.length;
  }
  if (lastIdx < text.length) {
    out.push({ kind: "text", text: text.slice(lastIdx) });
  }
  return out.length > 0 ? out : [{ kind: "text", text: "" }];
}
