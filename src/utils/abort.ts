// Recognising a user-initiated abort, wherever it surfaces. The platform fetch
// throws a DOMException named "AbortError"; the Anthropic SDK wraps it as
// `APIUserAbortError`. The constructor check is a fallback because that class
// lives on the SDK namespace and its `name` has shifted between versions.
//
// Callers use this to tell "the user hit Stop" apart from "the call failed" —
// the two want opposite handling (tear down vs. degrade and carry on).

export function isUserAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if (err.name === "APIUserAbortError") return true;
  const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
  return ctor === "APIUserAbortError";
}
