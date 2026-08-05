-- `basicInfoHuntedAt` is now the gate on whether the URL/ATS hunter runs for a
-- company (it used to be written but never read, while the gate was "is
-- sourceUrl null"). Any row that already has a sourceUrl has been hunted by
-- definition — without this backfill those companies re-hunt on next touch,
-- burning a hunter sub-agent run each and letting the canonical name / URL get
-- rewritten under the user.
--
-- createdAt (not now()) so the stamp doesn't claim the hunt happened today.

UPDATE "Company"
   SET "basicInfoHuntedAt" = "createdAt"
 WHERE "sourceUrl" IS NOT NULL
   AND "basicInfoHuntedAt" IS NULL;
