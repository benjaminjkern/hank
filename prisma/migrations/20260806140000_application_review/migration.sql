-- What the application critic concluded on its last pass, and what it couldn't
-- resolve. Purely additive: null means no review has run, which is what every
-- existing row correctly says — the loop discarded its verdict before this
-- column existed, so there is nothing to backfill from.
ALTER TABLE "JobInteraction" ADD COLUMN "applicationReview" JSONB;
