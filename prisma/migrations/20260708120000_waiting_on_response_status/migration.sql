-- Add a post-interview "waiting on the company" off-ramp.
--
-- Problem: after an interview a job flips INTERVIEW_SCHEDULED -> INTERVIEW_DEBRIEF
-- (a lazy read-path flip). INTERVIEW_DEBRIEF is focusNow AND lives in
-- OWED_JOB_STATUSES, so once the user has actually debriefed there is no state to
-- move it to — it keeps bubbling into "what's next" forever.
--
--   * InteractionStatus.WAITING_ON_RESPONSE — resting tone, NOT owed. A debriefed
--     interview lands here and drops out of "what's next". The whatsNext
--     stale-waiting tier resurfaces it only after ~14d of silence; an offer /
--     rejection / next-round event moves it on.
--   * EventType.AWAITING_RESPONSE — the transition-in event (mapped to the status
--     in EVENT_TO_STATUS). Logged by Hank after the user debriefs with no next
--     step booked.
--
-- Both are METADATA-ONLY additive ADD VALUEs (no table rewrite, no backfill).
-- Postgres 12+ allows ADD VALUE inside the migration transaction as long as the
-- value isn't USED here — it isn't; the code that writes them ships separately.
ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'WAITING_ON_RESPONSE';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'AWAITING_RESPONSE';
