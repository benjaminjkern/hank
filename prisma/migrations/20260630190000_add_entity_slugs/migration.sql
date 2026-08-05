-- Human-readable slugs the chat agent uses instead of opaque cuid ids.
-- Added nullable + backfilled separately (scripts/slug/backfill.ts) so this
-- migration is instant on a large table and existing rows keep working via the
-- id-fallback resolvers until the backfill runs. A follow-up migration can
-- enforce NOT NULL once every row has a slug and all creation sites mint one.

-- Job.slug: global handle (company-prefixed, unique by construction).
ALTER TABLE "Job" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "Job_slug_key" ON "Job"("slug");

-- Opportunity.slug: per-user handle derived from `label`.
ALTER TABLE "Opportunity" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "Opportunity_userId_slug_key" ON "Opportunity"("userId", "slug");

-- Contact.slug: per-user handle derived from `name`.
ALTER TABLE "Contact" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "Contact_userId_slug_key" ON "Contact"("userId", "slug");
