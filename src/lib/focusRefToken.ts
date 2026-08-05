import { escapeHtml, unescapeHtml } from "@/utils/html";
// `<focus-ref refKind="company|job|opportunity" id="X" label="..."/>` is an
// inline chat token, emitted SERVER-SIDE at focus-change seams (the show_* tools
// today; the deterministic pipeline seams in a later phase), that renders as a
// clickable chip navigating the right panel to that entity's detail page —
// view-only, exactly like <job-ref/> (see jobRefToken.ts).
//
// It rides inside a `pipeline_status` block's text ("Pulled up <focus-ref…/>")
// and splits out at render, so it reuses the whole pipeline_status channel
// (persist / stream / strip-for-the-LLM) with no new plumbing. The label is
// captured at emit time so the chip stays readable after a rename / delete, and
// the renderer never has to fetch.

// The parser only produces text and focus-ref pieces — status text is otherwise
// plain. Narrowing here keeps the render-side switch exhaustive.
export type FocusRefKind = "company" | "job" | "opportunity";

type FocusRefTokenPiece =
  | { kind: "text"; text: string }
  | { kind: "focus-ref"; refKind: FocusRefKind; id: string; label: string };

// id is a cuid (`c…` + alphanumeric); match conservatively so well-formed ids
// parse and arbitrary user-typed `<focus-ref/>` doesn't.
const FOCUS_REF_PATTERN =
  /<focus-ref\s+refKind="(company|job|opportunity)"\s+id="([A-Za-z0-9_-]+)"\s+label="([^"]*)"\s*\/>/g;

export function formatFocusRefToken(
  refKind: FocusRefKind,
  id: string,
  label: string,
): string {
  return `<focus-ref refKind="${refKind}" id="${id}" label="${escapeHtml(label)}"/>`;
}

// Split a string around `<focus-ref/>` tokens into a flat piece list of text
// pieces and focus-ref chips. Returns a single text segment (possibly empty)
// when no tokens are present, so callers can render uniformly. Original spacing
// around tokens is preserved (it carries meaning — "Pulled up " has a trailing
// space the chip sits next to).
export function splitFocusRefTokens(text: string): FocusRefTokenPiece[] {
  if (!text.includes("<focus-ref")) {
    return [{ kind: "text", text }];
  }
  const out: FocusRefTokenPiece[] = [];
  let lastIdx = 0;
  for (const match of text.matchAll(FOCUS_REF_PATTERN)) {
    const [whole, refKind, id, encodedLabel] = match;
    const start = match.index ?? 0;
    if (start > lastIdx) {
      out.push({ kind: "text", text: text.slice(lastIdx, start) });
    }
    out.push({
      kind: "focus-ref",
      refKind: refKind as FocusRefKind,
      id,
      label: unescapeHtml(encodedLabel),
    });
    lastIdx = start + whole.length;
  }
  if (lastIdx < text.length) {
    out.push({ kind: "text", text: text.slice(lastIdx) });
  }
  return out.length > 0 ? out : [{ kind: "text", text: "" }];
}

// Strip focus-ref tokens down to their bare label — for the model-facing
// provenance note (loadSessionMessages), so the LLM sees "Pulled up Stripe"
// rather than the raw `<focus-ref…/>` markup (which it must never learn to
// imitate — see "the screen is not yours to draw").
export function stripFocusRefTokens(text: string): string {
  return text.replace(
    FOCUS_REF_PATTERN,
    (_whole, _refKind, _id, encodedLabel) => unescapeHtml(encodedLabel),
  );
}
