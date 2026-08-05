-- Add REVIEWED to InteractionStatus. A job is REVIEWED after Hank has read
-- the full description and is presenting it for shortlist approval. The user
-- approves to bump REVIEWED → SHORTLISTED; rejection drops it to SKIPPED.
-- Lives between NEW (just scraped) and SHORTLISTED (user committed to apply).

ALTER TYPE "InteractionStatus" ADD VALUE IF NOT EXISTS 'REVIEWED' BEFORE 'SHORTLISTED';
