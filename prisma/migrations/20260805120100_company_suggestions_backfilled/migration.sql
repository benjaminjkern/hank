-- Reconstruct suggestion history from the checklists already on record, so the
-- discovery feedback loop starts knowing what the user has turned down instead
-- of re-proposing all of it once more.
--
-- Every batch the company search ever produced is still in ChatMessage.content
-- as a `pipeline_widget` block carrying its full suggestion list. A suggested
-- name the user KEPT became a CompanyInteraction (createCompanyStubs runs for
-- every pick, so even a pick whose enrichment failed left one behind), so
-- "suggested, and this user has no interaction for it" IS a decline.
--
-- Verdicts land as ADDED / DECLINED with no reason: the reason chips didn't
-- exist when these were answered, and inventing one would be worse than the
-- absence. runId stays NULL so none of this counts as "the latest round" — the
-- hard never-re-propose rule must not fire on reconstructed history.

DO $$
BEGIN
  -- Idempotent: a database that already has suggestions has been through this.
  IF EXISTS (SELECT 1 FROM "CompanySuggestion") THEN
    RETURN;
  END IF;

  -- The identity a suggestion is remembered under, matching suggestionKey() in
  -- entities/companies/companySuggestions.ts: drop a trailing "(Division)"
  -- qualifier, then slugify. Defined once and used on BOTH sides of the
  -- was-it-kept join, because the two drifting apart is the whole failure mode.
  -- pg_temp so it dies with the session and leaves no schema behind.
  CREATE FUNCTION pg_temp.suggestion_key(raw text) RETURNS text AS $fn$
    SELECT btrim(regexp_replace(lower(
      CASE WHEN btrim(regexp_replace($1, '\s*\([^)]*\)\s*$', '')) <> ''
           THEN btrim(regexp_replace($1, '\s*\([^)]*\)\s*$', ''))
           ELSE btrim($1) END), '[^a-z0-9]+', '-', 'g'), '-')
  $fn$ LANGUAGE sql IMMUTABLE;

  INSERT INTO "CompanySuggestion"
    ("id", "userId", "name", "nameKey", "reason", "url", "verdict",
     "sessionId", "createdAt", "decidedAt")
  WITH suggested AS (
    SELECT
      s."userId",
      m."sessionId",
      m."createdAt",
      btrim(e.value ->> 'name')                     AS name,
      nullif(btrim(e.value ->> 'reasoning'), '')    AS reason,
      nullif(btrim(e.value ->> 'url'), '')          AS url
    FROM "ChatMessage" m
    JOIN "ChatSession" s ON s.id = m."sessionId"
    CROSS JOIN LATERAL jsonb_array_elements(m.content) AS b
    CROSS JOIN LATERAL jsonb_array_elements(b -> 'payload' -> 'suggestions') AS e(value)
    WHERE jsonb_typeof(m.content) = 'array'
      AND b ->> 'type' = 'pipeline_widget'
      AND b ->> 'kind' = 'company_checklist'
      AND nullif(btrim(e.value ->> 'name'), '') IS NOT NULL
  ),
  -- One row per (user, identity): the same company proposed across three rounds
  -- is one history entry, and its most recent appearance is the one that counts.
  latest AS (
    SELECT DISTINCT ON ("userId", pg_temp.suggestion_key(name))
      "userId", "sessionId", "createdAt", name, reason, url,
      pg_temp.suggestion_key(name) AS "nameKey"
    FROM suggested
    ORDER BY "userId", pg_temp.suggestion_key(name), "createdAt" DESC
  ),
  -- Companies THIS user actually tracks. Per-user on purpose: Company is global,
  -- so matching on it would read another user's company as this user's pick.
  -- Both the keyed name and the raw slug count, since a company can be renamed
  -- after its slug is minted.
  owned AS (
    SELECT ci."userId", pg_temp.suggestion_key(c.name) AS "nameKey"
    FROM "CompanyInteraction" ci JOIN "Company" c ON c.id = ci."companyId"
    UNION
    SELECT ci."userId", c.slug
    FROM "CompanyInteraction" ci JOIN "Company" c ON c.id = ci."companyId"
  )
  SELECT
    -- These ids are opaque (nothing parses them) — a uuid here rather than a
    -- cuid only because cuid is minted by Prisma in app code, not by the DB.
    gen_random_uuid()::text,
    l."userId",
    l.name,
    l."nameKey",
    COALESCE(l.reason, '(reason not recorded)'),
    l.url,
    (CASE WHEN o."nameKey" IS NULL THEN 'DECLINED' ELSE 'ADDED' END)::"CompanySuggestionVerdict",
    l."sessionId",
    l."createdAt",
    l."createdAt"
  FROM latest l
  LEFT JOIN owned o ON o."userId" = l."userId" AND o."nameKey" = l."nameKey";
END $$;
