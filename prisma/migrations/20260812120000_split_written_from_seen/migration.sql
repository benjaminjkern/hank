-- Split "what Hank WROTE" from "what Hank has SEEN", and retire draftAuthors.
--
-- `proposedDrafts` was doing both jobs: the drafting pass stamped it with Hank's
-- text, and the panel-edit relay re-stamped it with whatever was on screen. That
-- fusion is why authorship needed a column of its own — a relay turned the
-- user's words into "Hank's baseline" one message later, so divergence stopped
-- being able to say who wrote anything.
--
-- Split apart, authorship needs no stamp at all: the live text either equals
-- what Hank wrote or it doesn't. That also buys the behaviour the stamp could
-- never have — edit an item, change your mind, put his wording back, and it is
-- his again, because it IS his again.
--
--   proposedDrafts  -> only Hank's own writes touch it. Whose words are these.
--   relayedDrafts   -> the relay and submit touch it. Has he seen this yet.
--
-- The conversion is exact rather than a guess, because draftAuthors currently
-- records who wrote each item. It is read here and dropped at the end.

ALTER TABLE "JobInteraction" ADD COLUMN IF NOT EXISTS "relayedDrafts" JSONB;

-- Today's proposedDrafts IS the seen-baseline, so copying it leaves every row
-- with exactly the set of unsent changes it already had.
UPDATE "JobInteraction"
SET "relayedDrafts" = "proposedDrafts"
WHERE "proposedDrafts" IS NOT NULL;

-- Match questions the way the app does (normalizeForCompare in src/utils/text.ts:
-- lowercase, collapse whitespace, trim). Defined once, called on both sides of
-- every join below, so the two halves can't drift.
CREATE FUNCTION pg_temp.norm_q(s text) RETURNS text
  LANGUAGE sql IMMUTABLE AS
  $$ SELECT btrim(regexp_replace(lower(s), '\s+', ' ', 'g')) $$;

-- Cut proposedDrafts back to only what Hank wrote. An item drops out when it is
-- BOTH the user's (draftAuthors says so) AND already relayed (the baseline has
-- caught up to their live text). A user edit that has NOT relayed yet leaves
-- Hank's older draft standing — which is precisely what a revert should restore.
UPDATE "JobInteraction" ji
SET "proposedDrafts" = jsonb_build_object(
  'coverLetter',
  CASE
    WHEN ji."draftAuthors" ->> 'coverLetter' = 'user'
     AND btrim(coalesce(ji."proposedDrafts" ->> 'coverLetter', ''))
         = btrim(coalesce(ji."coverLetter", ''))
      THEN 'null'::jsonb
    ELSE coalesce(ji."proposedDrafts" -> 'coverLetter', 'null'::jsonb)
  END,
  'answers',
  coalesce(
    (
      SELECT jsonb_agg(e ORDER BY ord)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(ji."proposedDrafts" -> 'answers') = 'array'
             THEN ji."proposedDrafts" -> 'answers' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS base(e, ord)
      WHERE NOT (
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(ji."draftAuthors" -> 'answers') = 'array'
                 THEN ji."draftAuthors" -> 'answers' ELSE '[]'::jsonb END
          ) AS a(elem)
          WHERE pg_temp.norm_q(a.elem ->> 'question')
              = pg_temp.norm_q(base.e ->> 'question')
            AND a.elem ->> 'author' = 'user'
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(ji."shortAnswers") = 'array'
                 THEN ji."shortAnswers" ELSE '[]'::jsonb END
          ) AS s(elem)
          WHERE pg_temp.norm_q(s.elem ->> 'question')
              = pg_temp.norm_q(base.e ->> 'question')
            AND btrim(coalesce(s.elem ->> 'answer', ''))
              = btrim(coalesce(base.e ->> 'text', ''))
        )
      )
    ),
    '[]'::jsonb
  )
)
WHERE ji."proposedDrafts" IS NOT NULL;

ALTER TABLE "JobInteraction" DROP COLUMN IF EXISTS "draftAuthors";

-- Findings are now anchored to a hash of the words they object to, and nothing
-- clears one by hand. Two stored reviews predate the anchor and neither has an
-- open finding, so they are reset rather than given a compat reader: the next
-- pass writes a fresh verdict, and a dual-format reader here would be permanent.
UPDATE "JobInteraction" SET "applicationReview" = NULL
WHERE "applicationReview" IS NOT NULL;
