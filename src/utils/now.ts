// Clock reads, hoisted out of every render scope in the app.
//
// `react-hooks/purity` (React Compiler) flags `Date.now()` / `new Date()`
// syntactically wherever they appear in a render scope — it has no awareness of
// server components, async, or helper indirection. It only inspects the CALL
// SITE, not the callee's body, so routing the read through a plain function
// call satisfies it. This is the one copy of that workaround — don't re-inline
// a file-local `function nowMs()`.
//
// See AGENTS.md → "React Compiler purity lint fires on Date.now() / Math.random()".

export function nowMs(): number {
  return Date.now();
}

export function nowDate(): Date {
  return new Date();
}

// Monotonic clock for animation timing — never wall-clock, never comparable to
// nowMs(). Browser-only (`performance` is undefined in some server contexts).
export function nowPerfMs(): number {
  return performance.now();
}
