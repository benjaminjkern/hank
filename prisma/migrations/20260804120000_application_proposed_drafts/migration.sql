-- The application text as Hank last wrote it, so a user edit is derivable
-- (live text <> proposedDrafts) instead of needing a dirty flag.
ALTER TABLE "JobInteraction" ADD COLUMN "proposedDrafts" JSONB;

-- Backfill the baseline to each row's CURRENT text. Hank's original wording is
-- unrecoverable for anything the user already edited, and guessing from the
-- reuse flags would relay every historical hand-edit as if it just happened.
-- Snapshotting what's there means nothing pre-existing reports as a change and
-- every edit from here on diverges correctly.
UPDATE "JobInteraction" ji
SET "proposedDrafts" = jsonb_build_object(
  'coverLetter', COALESCE(to_jsonb(ji."coverLetter"), 'null'::jsonb),
  'answers',
    COALESCE(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'question', e.value ->> 'question',
                   'text',     e.value ->> 'answer'
                 )
                 ORDER BY e.ord
               )
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(ji."shortAnswers") = 'array'
                    THEN ji."shortAnswers"
                    ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS e(value, ord)
        WHERE e.value ->> 'question' IS NOT NULL
          AND e.value ->> 'answer' IS NOT NULL
      ),
      '[]'::jsonb
    )
)
WHERE ji."coverLetter" IS NOT NULL
   OR jsonb_typeof(ji."shortAnswers") = 'array';
