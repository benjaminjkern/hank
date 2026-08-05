// Renders a Job's open-ended attribute BAGS as flat `key=value` lines, for the
// per-job blocks the sub-agents build above a posting. Nested objects/arrays are
// flattened to a readable string; each value is capped so one verbose field
// can't bloat a per-job line. The closed set of promoted scalars is the separate
// concern next door — see roleAttrs.ts.
//
// There are two bags, and a call site picks them deliberately:
//
//   `Job.attributes` — the RAW provider job object (minus the description blobs,
//   which live in rawContent); see rawAttrs() in scrape/ats/shared.ts. It is
//   deliberately NOT curated: capturing the whole response wholesale means a
//   newly-added (or drifted) ATS can't silently drop a field just because nobody
//   wired a column for it. **Every call site includes it** — it's the only view
//   of what the board returned beyond the promoted columns, and its overlap with
//   them is intentional.
//
//   `Job.enrichedAttributes` — the enrich pass's scalars, extracted FROM
//   `rawContent` (comp / location / remote / seniorityLevel / requiredYoE /
//   employmentType / department). **It rides along only where the body doesn't**:
//   a call site that already passes the full posting body gets nothing from a
//   terse pullout of that same body. A call site working from metadata alone
//   (pre-scan) or from the compressed summary (scan, shortlist) keeps it — the
//   structured `remote=onsite|hybrid` / `seniorityLevel` / `requiredYoE` scalars
//   are gate inputs that prose can leave ambiguous, and a bare scraped city
//   otherwise reads as possibly-remote downstream. `enrich_job` never sees it:
//   it's that sub-agent's own output.
import { truncate } from "@/utils/text";

export function attributePairs(attributes: unknown): string[] {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  )
    return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(attributes as Record<string, unknown>)) {
    const rendered = renderAttrValue(v);
    if (rendered) out.push(`${k}=${rendered}`);
  }
  return out;
}

function renderAttrValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return truncate(v.trim(), 100);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v
      .map((item) =>
        item != null && typeof item === "object"
          ? renderObject(item as Record<string, unknown>)
          : item == null
            ? ""
            : String(item),
      )
      .filter(Boolean);
    return truncate(parts.join("; "), 100);
  }
  return truncate(renderObject(v as Record<string, unknown>), 100);
}

// Collapse an object to a readable token: prefer the common label shapes
// providers use ({name,value} metadata, {descriptor} Workday refs, {name} /
// {location} lists), else a compact primitive-only k:v list.
function renderObject(o: Record<string, unknown>): string {
  if (o.name != null && o.value != null) return `${o.name}: ${o.value}`;
  if (typeof o.descriptor === "string") return o.descriptor;
  if (typeof o.name === "string") return o.name;
  if (typeof o.location === "string") return o.location;
  return Object.entries(o)
    .filter(([, vv]) => vv != null && vv !== "" && typeof vv !== "object")
    .map(([k, vv]) => `${k}:${vv}`)
    .join(", ");
}
