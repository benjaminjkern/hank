// Tagging + run-id helpers so every row this harness writes to the (PROD)
// database is identifiable and sweepable, with its own tag prefix so parallel
// harnesses never collide on cleanup.

export const QA_TAG = "[qa-audit]";

// Deterministic-ish run id. Date.now()/Math.random() are fine here — this is
// a standalone CLI script, not React render scope, and not resumed.
export function makeRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 6);
  return `${ts}-${rand}`;
}

// The ephemeral user's email encodes the runId + persona so cleanup can find
// every user a run created (and a crashed run's orphans) by email prefix.
// Uses the +tag form on a domain that will never receive mail.
export function tagEmail(runId: string, personaId: string): string {
  return `qa-audit+${runId}__${personaId}@harness.invalid`;
}

export function tagName(runId: string, personaId: string): string {
  return `${QA_TAG} ${personaId} (${runId})`;
}

export function tagSessionSummary(runId: string, personaId: string): string {
  return `${QA_TAG} persona=${personaId} run=${runId}`;
}

// Email prefix shared by every user a run created — the cleanup path matches
// on this with a `startsWith` / `contains` query.
export function runEmailPrefix(runId: string): string {
  return `qa-audit+${runId}__`;
}
