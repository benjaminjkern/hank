-- Add Company.greenhouseSlug for companies hosted on Greenhouse, including
-- those whose per-job sourceUrl is a custom careers domain that strips the
-- `greenhouse.io` host (Databricks, Stripe, CoreWeave, …). Lets the apply-form
-- scraper reconstruct the canonical Greenhouse embed URL.
ALTER TABLE "Company" ADD COLUMN "greenhouseSlug" TEXT;

-- Backfill from existing sourceUrls so already-scraped companies don't have to
-- re-run the URL hunter. Covers both `boards.greenhouse.io/<slug>` and
-- `job-boards.greenhouse.io/<slug>` shapes; the trailing path / query is
-- stripped by the substring-of-first-`/`-or-`?` extraction.
UPDATE "Company"
SET "greenhouseSlug" = substring("sourceUrl" FROM '^https?://(?:job-boards|boards)\.greenhouse\.io/([^/?#]+)')
WHERE "sourceUrl" ~* '^https?://(?:job-boards|boards)\.greenhouse\.io/[^/?#]+';

UPDATE "Company"
SET "greenhouseSlug" = substring("sourceUrl" FROM '^https?://boards-api\.greenhouse\.io/v1/boards/([^/?#]+)')
WHERE "greenhouseSlug" IS NULL
  AND "sourceUrl" ~* '^https?://boards-api\.greenhouse\.io/v1/boards/[^/?#]+';
