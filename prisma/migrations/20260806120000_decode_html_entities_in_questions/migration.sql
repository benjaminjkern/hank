-- Decode HTML entities left in stored application-question text.
--
-- decodeEntities() only handled DECIMAL numeric entities (`&#(\d+);`), so every
-- hex one survived the scrape and reached the user as literal `&#x27;`. The
-- parser is fixed; these are the rows written before that.
--
-- Why four columns and not one: a question is keyed BY ITS TEXT everywhere
-- (questionId / normalizeForCompare, which only lowercases and collapses
-- whitespace — punctuation is significant). Decoding Job.applicationQuestions
-- alone would orphan every answer, decision and draft saved against the encoded
-- spelling. All five columns move together or none do.
--
-- The decoder is defined ONCE as a pg_temp function and called on every column,
-- so the halves cannot drift from each other. It mirrors src/utils/html.ts
-- decodeEntities: named entities, then hex, then decimal. Operating on the
-- whole JSON text is safe — JSON string escaping doesn't use `&`.

-- A numeric entity is only substituted when the character it names can sit in a
-- JSON string literal unescaped. Anything else is left as the entity: a visible
-- `&#10;` is a far better outcome than a migration that aborts on a cast.
CREATE FUNCTION pg_temp.is_json_safe(code int) RETURNS boolean AS $$
  SELECT code >= 32
     AND code <= 1114111
     AND NOT (code BETWEEN 127 AND 159)
     AND chr(code) NOT IN ('"', '\');
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.decode_entities(s text) RETURNS text AS $$
DECLARE
  out text := s;
  m text[];
  code int;
BEGIN
  out := replace(out, '&nbsp;', ' ');
  out := replace(out, '&amp;', '&');
  out := replace(out, '&lt;', '<');
  out := replace(out, '&gt;', '>');
  -- `&quot;` is deliberately NOT decoded. Unlike the TS function, this one
  -- rewrites the whole JSON document as text, so any character that has to be
  -- escaped inside a JSON string would make the ::jsonb cast below fail and
  -- abort the migration. Same reason `is_json_safe` rejects `"`, `\` and the
  -- control range. Nothing stored today hits those (the only entity present in
  -- this data is `&#x27;`), and the app-side decoder handles them on the next
  -- scrape, where it's a plain JS string with no such constraint.
  out := replace(out, '&#39;', '''');
  out := replace(out, '&apos;', '''');

  -- Hex before decimal, same order as the TS function.
  FOR m IN SELECT regexp_matches(out, '&#[xX]([0-9a-fA-F]+);', 'g') LOOP
    code := ('x' || lpad(m[1], 8, '0'))::bit(32)::int;
    IF pg_temp.is_json_safe(code) THEN
      out := replace(out, '&#x' || m[1] || ';', chr(code));
      out := replace(out, '&#X' || m[1] || ';', chr(code));
    END IF;
  END LOOP;

  FOR m IN SELECT regexp_matches(out, '&#([0-9]+);', 'g') LOOP
    code := m[1]::int;
    IF pg_temp.is_json_safe(code) THEN
      out := replace(out, '&#' || m[1] || ';', chr(code));
    END IF;
  END LOOP;

  RETURN out;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "Job"
SET "applicationQuestions" =
      pg_temp.decode_entities("applicationQuestions"::text)::jsonb
WHERE "applicationQuestions"::text ~ '&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|nbsp|apos);';

UPDATE "Job"
SET "userAddedQuestions" =
      pg_temp.decode_entities("userAddedQuestions"::text)::jsonb
WHERE "userAddedQuestions"::text ~ '&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|nbsp|apos);';

UPDATE "JobInteraction"
SET "shortAnswers" = pg_temp.decode_entities("shortAnswers"::text)::jsonb
WHERE "shortAnswers"::text ~ '&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|nbsp|apos);';

UPDATE "JobInteraction"
SET "draftDecision" = pg_temp.decode_entities("draftDecision"::text)::jsonb
WHERE "draftDecision"::text ~ '&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|nbsp|apos);';

UPDATE "JobInteraction"
SET "proposedDrafts" = pg_temp.decode_entities("proposedDrafts"::text)::jsonb
WHERE "proposedDrafts"::text ~ '&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|nbsp|apos);';
