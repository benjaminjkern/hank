// Parses only when the string actually looks like JSON, so a plain prose string
// comes back `undefined` instead of costing a thrown-and-caught SyntaxError.
export function tryParseJson(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// Best-effort display string for a value of unknown shape: strings pass
// through, everything else is pretty-printed JSON, and anything unserializable
// (a cycle, a BigInt) falls back to String(). Never throws.
export function prettyJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
