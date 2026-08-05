// In-memory registry of active runUserMessage invocations, one per
// ChatSession. Lives in process memory only — a server restart orphans any
// in-flight run, but the next user message replays cleanly via
// repairOrphanToolUses in session.ts. Used by:
//   - POST /api/chat (the runUserMessage entrypoint claims the session on
//     entry, clears in finally) — also serves the ALREADY_STREAMING guard via
//     claimSessionForNewRun (see src/server/agent/runtime/runUserMessage.ts)
//   - POST /api/chat/stop (a single Stop press aborts the run's controller,
//     tearing down the in-flight Anthropic stream + tool call immediately;
//     the runner degrades to the partial and persists it — see agentRunner.ts)

import { nowMs } from "@/utils/now";

type StopState = {
  controller: AbortController;
  userId: string;
  startedAt: number;
};

const activeRuns = new Map<string, StopState>();

export function registerActiveRun(
  sessionId: string,
  userId: string,
  controller: AbortController,
): void {
  activeRuns.set(sessionId, { controller, userId, startedAt: nowMs() });
}

export function clearActiveRun(sessionId: string): void {
  activeRuns.delete(sessionId);
}

export function getActiveRun(
  sessionId: string,
): { userId: string; controller: AbortController } | null {
  const run = activeRuns.get(sessionId);
  if (!run) return null;
  return { userId: run.userId, controller: run.controller };
}

// Claim the session for a new run, reclaiming a STALE prior run instead of
// blocking on it. A run is stale when its controller was already aborted (a
// Stop or the route's MAX_RUN_MS cap fired but the run didn't unwind — e.g. it
// wedged on a hung await / a loop that never checks the signal, so its finally
// never ran clearActiveRun) or it has outlived `maxAgeMs`. A stale run must not
// lock the user out until a process restart — the exact "couldn't chat, only a
// refresh fixed it" trap. Returns true when the caller may start a fresh run
// (session was clear or just reclaimed); false when a genuinely-live run holds
// it (the ALREADY_STREAMING refusal, which prevents interleaved DB writes).
export function claimSessionForNewRun(
  sessionId: string,
  maxAgeMs: number,
): boolean {
  const run = activeRuns.get(sessionId);
  if (!run) return true;
  const stale =
    run.controller.signal.aborted || nowMs() - run.startedAt > maxAgeMs;
  if (!stale) return false;
  try {
    run.controller.abort();
  } catch {
    // already aborted / no listeners — reclaiming regardless.
  }
  activeRuns.delete(sessionId);
  return true;
}
