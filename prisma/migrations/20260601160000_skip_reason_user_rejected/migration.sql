-- Add USER_REJECTED to the SkipReason enum.
-- Used by the shortlist widget commit endpoint when the user unchecks a job
-- from Hank's viable pool. Distinct from OUTRANKED (Hank's vocabulary during
-- PRE_SCAN/POST_SCAN); USER_REJECTED is the user's vocabulary.
ALTER TYPE "SkipReason" ADD VALUE 'USER_REJECTED';
