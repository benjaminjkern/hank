-- Two additions to JobInteraction, both about an application in progress.
--
-- 1. JobInteractionStatus.APPLYING — "a drafting pass has started on this one".
--    SHORTLISTED meant both "queued to apply to" and "actively being written",
--    so nothing could tell a role waiting its turn from the one on screen.
--    Additive: no collision (JobInteractionStatus has no APPLYING), no rows
--    carry it yet, and runDraftApplication starts writing it going forward.
--
-- 2. draftAuthors — who wrote each item's live text. This was previously
--    inferred as "the reuse flag is on OR the text diverges from
--    proposedDrafts", which is wrong in both directions: ticking "reuse when
--    drafting" on Hank's untouched draft relabelled it the user's, and relaying
--    a user edit re-baselines proposedDrafts to their words, so the divergence
--    that proved authorship disappears one message later. The reuse flag is
--    load-bearing for a different question (may we draw on this text next
--    time), so authorship gets its own record, stamped at write time.
--
-- The backfill below reproduces the old inference once, against every row that
-- has text, so nothing needs a fallback reader afterwards. It has to match the
-- TS rule exactly, so the question-matching normalizer is defined once here and
-- called on both sides of the join (mirrors normalizeForCompare in
-- src/utils/text.ts: lowercase, collapse whitespace, trim).

ALTER TYPE "JobInteractionStatus" ADD VALUE IF NOT EXISTS 'APPLYING';

ALTER TABLE "JobInteraction" ADD COLUMN IF NOT EXISTS "draftAuthors" JSONB;

CREATE FUNCTION pg_temp.norm_q(s text) RETURNS text
  LANGUAGE sql IMMUTABLE AS
  $$ SELECT btrim(regexp_replace(lower(s), '\s+', ' ', 'g')) $$;

-- One author verdict per item, by the pre-column rule:
--   reuse = true                      -> 'user'  (they claimed it)
--   no baseline entry, text non-empty -> 'user'  (nobody drafted it)
--   text differs from the baseline    -> 'user'  (they rewrote it)
--   otherwise                         -> 'hank'
WITH cover AS (
  SELECT
    ji.id,
    CASE
      WHEN btrim(coalesce(ji."coverLetter", '')) = '' THEN NULL
      WHEN ji."coverLetterReuse" IS TRUE THEN 'user'
      WHEN ji."proposedDrafts" IS NULL
        OR jsonb_typeof(ji."proposedDrafts" -> 'coverLetter') = 'null'
        OR ji."proposedDrafts" -> 'coverLetter' IS NULL THEN 'user'
      WHEN btrim(ji."proposedDrafts" ->> 'coverLetter')
             IS DISTINCT FROM btrim(ji."coverLetter") THEN 'user'
      ELSE 'hank'
    END AS author
  FROM "JobInteraction" ji
),
answers AS (
  SELECT
    ji.id,
    jsonb_build_object(
      'question', a.elem ->> 'question',
      'author',
      CASE
        -- WITH ORDINALITY counts from 1; the parallel reuse array is 0-based.
        WHEN (ji."shortAnswersReuse" -> (a.idx::int - 1))::text = 'true' THEN 'user'
        WHEN base.text IS NULL THEN 'user'
        WHEN btrim(base.text) IS DISTINCT FROM btrim(coalesce(a.elem ->> 'answer', ''))
          THEN 'user'
        ELSE 'hank'
      END
    ) AS entry,
    a.idx
  FROM "JobInteraction" ji
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(ji."shortAnswers") = 'array'
         THEN ji."shortAnswers" ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS a(elem, idx)
  LEFT JOIN LATERAL (
    SELECT b.elem ->> 'text' AS text
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ji."proposedDrafts" -> 'answers') = 'array'
           THEN ji."proposedDrafts" -> 'answers' ELSE '[]'::jsonb END
    ) AS b(elem)
    WHERE pg_temp.norm_q(b.elem ->> 'question')
        = pg_temp.norm_q(a.elem ->> 'question')
    LIMIT 1
  ) AS base ON TRUE
  WHERE btrim(coalesce(a.elem ->> 'answer', '')) <> ''
),
rolled AS (
  SELECT id, jsonb_agg(entry ORDER BY idx) AS answers FROM answers GROUP BY id
)
UPDATE "JobInteraction" ji
SET "draftAuthors" = jsonb_build_object(
  'coverLetter', to_jsonb(cover.author),
  'answers', coalesce(rolled.answers, '[]'::jsonb)
)
FROM cover
LEFT JOIN rolled ON rolled.id = cover.id
WHERE ji.id = cover.id
  AND (cover.author IS NOT NULL OR rolled.answers IS NOT NULL);
