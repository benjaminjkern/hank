// Narrowing helpers for `unknown` values — parsed JSON, replayed message
// blocks, scraped API payloads. All total: they never throw, they return null /
// [] / false rather than asserting.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Treats "" as absent — for fields where an empty string is as useless as a
// missing one (labels, ids, hrefs).
export function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Renderable as a single cell — anything that isn't an object or array.
export function isScalar(v: unknown): boolean {
  return (
    v == null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// Reads one string field off a bag of unknown shape, falling back when the key
// is missing, non-string, or empty.
export function stringField(
  obj: Record<string, unknown> | null | undefined,
  key: string,
  fallback: string,
): string {
  const v = obj?.[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
