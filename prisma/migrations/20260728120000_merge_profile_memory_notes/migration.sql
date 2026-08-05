-- Merge the two profile memory notes into one: overall.md + users/me.md -> profile.md.
--
-- They had no separable job. Every consumer read BOTH in the same Promise.all
-- and concatenated them, and in practice both files grew their own
-- "## Dealbreakers" and "## Shortlist guardrails" — the consolidation prompt
-- needed a precedence rule to arbitrate them, which is the tell that they could
-- hold the same fact. resume.md is untouched: its lifecycle genuinely differs
-- (layer 1 is machine-written, regenerated on every resume upload).
--
-- Ordering: thesis first, then the about-me content, matching the section order
-- the new consolidation prompt writes. Users with only one of the two get that
-- one verbatim. The `users/` path namespace is retired with this migration —
-- users/me.md was its only member across every user.

-- 1. Users who have BOTH notes: concatenate, thesis first.
INSERT INTO "MemoryNote" ("userId", path, content, "updatedAt")
SELECT
  o."userId",
  'profile.md',
  rtrim(o.content, E' \t\n') || E'\n\n' || ltrim(m.content, E' \t\n'),
  GREATEST(o."updatedAt", m."updatedAt")
FROM "MemoryNote" o
JOIN "MemoryNote" m ON m."userId" = o."userId" AND m.path = 'users/me.md'
WHERE o.path = 'overall.md'
ON CONFLICT ("userId", path) DO UPDATE SET
  content = EXCLUDED.content,
  "updatedAt" = EXCLUDED."updatedAt";

-- 2. Users who have exactly ONE of the two: carry it over verbatim.
INSERT INTO "MemoryNote" ("userId", path, content, "updatedAt")
SELECT n."userId", 'profile.md', n.content, n."updatedAt"
FROM "MemoryNote" n
WHERE n.path IN ('overall.md', 'users/me.md')
  AND NOT EXISTS (
    SELECT 1 FROM "MemoryNote" other
    WHERE other."userId" = n."userId"
      AND other.path IN ('overall.md', 'users/me.md')
      AND other.path <> n.path
  )
ON CONFLICT ("userId", path) DO UPDATE SET
  content = EXCLUDED.content,
  "updatedAt" = EXCLUDED."updatedAt";

-- 3. Drop the old rows. validatePath no longer accepts either path, so a
--    surviving row would be unreadable — readMemory throws before the query.
DELETE FROM "MemoryNote" WHERE path = 'overall.md' OR path = 'users/me.md';

-- 4. The users/ namespace is gone entirely. users/me.md was its only member, so
--    this is a belt-and-braces assertion rather than a delete: if some other
--    users/*.md row exists, it would be silently unreachable after this
--    migration and we want the failure to be loud instead.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "MemoryNote" WHERE path LIKE 'users/%';
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'the users/ memory namespace was retired, but % row(s) remain under users/*.md — decide where they belong (probably profile.md) before re-running', orphans;
  END IF;
END $$;
