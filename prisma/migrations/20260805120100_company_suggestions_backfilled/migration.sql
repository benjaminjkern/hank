-- Gate for scripts/migrations/2026-08-05-backfill-company-suggestions.ts.
--
-- The backfill reconstructs suggestion history from persisted company_checklist
-- widget payloads, which needs the runtime's slugify() — so it's a script, and
-- this asserts it ran. Without it the feedback loop starts empty and re-proposes
-- everything the user has already turned down.
--
-- The check is "any checklist batch on record but no suggestion rows": a
-- database that has never rendered a checklist has nothing to reconstruct and
-- passes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ChatMessage" m, LATERAL jsonb_array_elements(m.content) AS b
    WHERE jsonb_typeof(m.content) = 'array'
      AND b ->> 'type' = 'pipeline_widget'
      AND b ->> 'kind' = 'company_checklist'
  ) AND NOT EXISTS (SELECT 1 FROM "CompanySuggestion") THEN
    RAISE EXCEPTION
      'Run `pnpm tsx scripts/migrations/2026-08-05-backfill-company-suggestions.ts --apply` first (dry-run without --apply), then re-run this migration.';
  END IF;
END $$;
