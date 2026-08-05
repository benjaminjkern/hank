// FNV-1a over a string → 8 hex chars. Deterministic, dependency-free, and
// stable across processes — for content-addressed ids and cache keys, never
// for anything security-bearing.
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
