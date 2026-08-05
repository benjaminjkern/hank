-- Gate for scripts/migrations/2026-07-30-resume-md-to-background.ts.
--
-- That conversion re-runs the résumé parser over stored PDF bytes, so it can't
-- be expressed as SQL. This entry only ASSERTS it ran: a resume.md still
-- carrying the old machine-generated banner is a note the script never
-- converted. See scripts/migrations/README.md → "Every script is paired with a
-- gate migration".

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryNote"
    WHERE "path" = 'resume.md' AND "content" LIKE '# Resume Summary%'
  ) THEN
    RAISE EXCEPTION 'resume.md notes still hold the generated summary banner. Run `pnpm tsx scripts/migrations/2026-07-30-resume-md-to-background.ts --apply` first, then re-run this migration.';
  END IF;
END $$;
