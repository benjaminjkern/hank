// Refresh policy for a job's scraped application-questions envelope: when a
// cached {status} envelope is stale enough to re-fetch. Domain rule (how long an
// ATS form read stays trusted), shared by view_application_questions and the
// draft-application procedure.

import type { ApplicationQuestionsEnvelope } from "@/server/scrape/types";

// Refetch an ATS questions {status: "error"} envelope after this many ms.
const QUESTIONS_ERROR_REFRESH_MS = 24 * 60 * 60 * 1000;
// Retry a {status: "unsupported"} envelope after this many ms. "unsupported"
// isn't permanent — a scraper can gain support for an ATS, or a posting's apply
// flow can change from login/SPA-gated to fetchable. "ok"/"empty" stay permanent
// (a form we successfully read doesn't need re-reading).
const QUESTIONS_UNSUPPORTED_REFRESH_MS = 24 * 60 * 60 * 1000;

export function needsQuestionsRefresh(
  env: ApplicationQuestionsEnvelope | null,
): boolean {
  if (!env) return true;
  if (env.status === "error") {
    const ageMs = Date.now() - new Date(env.fetchedAt).getTime();
    return ageMs > QUESTIONS_ERROR_REFRESH_MS;
  }
  if (env.status === "unsupported") {
    // Legacy rows written before fetchedAt existed have no stamp — treat as
    // stale so they get one retry (and a fresh stamp) on next access.
    if (!env.fetchedAt) return true;
    const ageMs = Date.now() - new Date(env.fetchedAt).getTime();
    return ageMs > QUESTIONS_UNSUPPORTED_REFRESH_MS;
  }
  return false; // ok / empty are permanent
}
