-- Memory note paths: cuid → slug, so no ids are ever shown to the agent.
-- jobs/{cuid}.md → jobs/{Job.slug}.md and opportunities/{cuid}.md →
-- opportunities/{Opportunity.slug}.md, joined via the denormalized FK columns.
-- Only rows whose entity has a slug; slug-less legacy entities keep their id
-- path (the store still resolves it). Idempotent — re-running writes the same
-- value, and the final predicate skips rows already at the slug path.
UPDATE "MemoryNote" mn
SET "path" = 'jobs/' || j."slug" || '.md'
FROM "Job" j
WHERE mn."jobId" = j."id"
  AND j."slug" IS NOT NULL
  AND mn."path" LIKE 'jobs/%'
  AND mn."path" <> 'jobs/' || j."slug" || '.md';

UPDATE "MemoryNote" mn
SET "path" = 'opportunities/' || o."slug" || '.md'
FROM "Opportunity" o
WHERE mn."opportunityId" = o."id"
  AND o."slug" IS NOT NULL
  AND mn."path" LIKE 'opportunities/%'
  AND mn."path" <> 'opportunities/' || o."slug" || '.md';
