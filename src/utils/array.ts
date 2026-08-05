// Splits into consecutive runs of at most `size`. A list shorter than `size`
// comes back as a single chunk (never an empty outer array), so callers can
// treat "one chunk" and "many chunks" identically.
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
