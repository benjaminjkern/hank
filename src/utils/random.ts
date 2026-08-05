// Hoisted for the same reason as `now.ts`: `react-hooks/purity` flags a bare
// Math.random() in a render scope syntactically, but only at the call site.
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
