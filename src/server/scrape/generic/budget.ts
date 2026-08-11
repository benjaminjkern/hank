// A wall-clock budget the probe checks between tiers.
//
// The scrape it sits inside is capped at 90s (runScrapeJobsForCompany), and
// discovery is speculative work — every tier is a guess that might cost a dozen
// requests. Without a budget the sitemap tier alone can spend the whole scrape.
//
// Deliberately NOT an AbortSignal: the user's Stop is already ambient
// (scrapeSignal.ts) and reaches every fetch. This is a coarser thing — "stop
// GUESSING and report what you have" — and conflating the two would let a
// budget expiry look like an abort.

import { nowMs } from "@/utils/now";

export type TimeBudget = {
  expired: () => boolean;
  remainingMs: () => number;
};

export function withTimeBudget(totalMs: number): TimeBudget {
  const deadline = nowMs() + totalMs;
  return {
    expired: () => nowMs() >= deadline,
    remainingMs: () => Math.max(0, deadline - nowMs()),
  };
}
