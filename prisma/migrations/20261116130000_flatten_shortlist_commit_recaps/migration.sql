-- Rewrites the old `<!--shortlist-commit:{json}-->` recap user messages into
-- one plain line, so the client renders them as an ordinary bubble and needs no
-- card that understands the marker.

CREATE FUNCTION pg_temp.shortlist_commit_recap(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '[Locked in the ' || (j->>'companyName') || ' shortlist — '
    || jsonb_array_length(j->'approved') || ' picked, '
    || jsonb_array_length(j->'skipped') || ' passed on]'
    || coalesce(E'\nReason: ' || nullif(btrim(j->>'reason'), ''), '')
  FROM (
    SELECT substr(
      t,
      length('<!--shortlist-commit:') + 1,
      position('-->' in t) - length('<!--shortlist-commit:') - 1
    )::jsonb AS j
  ) s
$$;

UPDATE "ChatMessage" m
SET content = (
  SELECT jsonb_agg(
    CASE
      WHEN b->>'type' = 'text' AND b->>'text' LIKE '<!--shortlist-commit:%'
        THEN jsonb_set(b, '{text}', to_jsonb(pg_temp.shortlist_commit_recap(b->>'text')))
      ELSE b
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(m.content) WITH ORDINALITY AS e(b, ord)
)
WHERE jsonb_typeof(m.content) = 'array'
  AND m.content::text LIKE '%<!--shortlist-commit:%';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ChatMessage" WHERE content::text LIKE '%<!--shortlist-commit:%'
  ) THEN
    RAISE EXCEPTION 'shortlist-commit markers remain after the rewrite';
  END IF;
END $$;
