// When a learned board reader stops being trustworthy.
//
// The rule is narrow on purpose. Because a learned board NEVER delists (see
// isLearnedSource in scrape/types.ts), health can't quietly cause damage — its
// only job is to stop us re-running a plan that no longer reads the board, and
// to make the company eligible for re-authoring. So there is no promotion tier
// and no trust ladder: HEALTHY or QUARANTINED, one direction per event.

import { BoardReaderHealth } from "@/generated/prisma/client";

// Consecutive failed runs before we stop trying the stored plan. Three rather
// than one because a board being down for a day is far more common than a
// recipe going stale, and re-authoring costs an LLM call.
export const MAX_CONSECUTIVE_FAILURES = 3;
// Below this, the run returned so little of what we already hold that the
// locator is more likely broken than the board emptied.
export const MIN_OVERLAP_RATIO = 0.5;
// Overlap is only meaningful once there's a real board to compare against.
export const MIN_BOARD_FOR_OVERLAP = 5;

export type ReaderRunOutcome =
  | {
      ok: true;
      jobs: number;
      // Open postings we hold that this run didn't return, and how much of the
      // previous set it did. Absent on a first run — nothing to compare to.
      missing?: number;
      openCount?: number;
      overlap?: number;
    }
  // `structural` marks a failure that says the PLAN is wrong (validation
  // rejected the output, a posting was stolen from another company) rather than
  // that the network blipped — those quarantine immediately instead of burning
  // three days of retries.
  | { ok: false; structural: boolean };

export function nextHealth(
  current: { health: BoardReaderHealth; consecutiveFailures: number },
  outcome: ReaderRunOutcome,
): { health: BoardReaderHealth; consecutiveFailures: number } {
  if (!outcome.ok) {
    const failures = current.consecutiveFailures + 1;
    const quarantine =
      outcome.structural || failures >= MAX_CONSECUTIVE_FAILURES;
    return {
      health: quarantine
        ? BoardReaderHealth.QUARANTINED
        : BoardReaderHealth.HEALTHY,
      consecutiveFailures: failures,
    };
  }

  // A board that returns nothing when we hold several open postings is the
  // silent failure this whole layer exists to catch — the fetch succeeded, the
  // list was empty, and nothing else would have noticed.
  const emptiedNonTrivialBoard =
    outcome.jobs === 0 && (outcome.openCount ?? 0) >= MIN_BOARD_FOR_OVERLAP;
  const overlapCollapsed =
    outcome.overlap != null &&
    (outcome.openCount ?? 0) >= MIN_BOARD_FOR_OVERLAP &&
    outcome.overlap < MIN_OVERLAP_RATIO;

  return {
    health:
      emptiedNonTrivialBoard || overlapCollapsed
        ? BoardReaderHealth.QUARANTINED
        : BoardReaderHealth.HEALTHY,
    consecutiveFailures: 0,
  };
}

// How long a failed recon is remembered. Without it, a permanently unreadable
// board re-pays for an LLM call on every 24h staleness tick, forever.
export const RECON_COOLDOWN_DAYS = 14;

export function reconOnCooldown(reconnedAt: Date | null, now: Date): boolean {
  if (!reconnedAt) return false;
  const days = (now.getTime() - reconnedAt.getTime()) / 86_400_000;
  return days < RECON_COOLDOWN_DAYS;
}
