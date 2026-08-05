-- Tracks how the user reached APPLIED on a JobInteraction. RECRUITER (external
-- agency or in-house recruiter mediating), REFERRAL (friend pointed at a job
-- the user applied to direct), DIRECT (scan-flow / careers-page path). Null
-- for pre-feature APPLIED rows; tools default new APPLIED rows from the
-- JobInteraction's `opportunityId` link.

CREATE TYPE "ApplyChannel" AS ENUM ('DIRECT', 'RECRUITER', 'REFERRAL');

ALTER TABLE "JobInteraction" ADD COLUMN "applyChannel" "ApplyChannel";
