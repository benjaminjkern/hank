-- Hank can now mark a discovery candidate himself, and the search records what
-- it actually found out about each one.
--
-- Both nullable with no backfill, and neither is a half-migration: a null
-- `agentMark` IS the search's default proposal (ADD), which is exactly what
-- every existing row means, and a null `summary` is a fact about rows written
-- before the search returned one — there is nothing to reconstruct it from.
ALTER TABLE "CompanySuggestion" ADD COLUMN "agentMark" "CompanySuggestionMark";
ALTER TABLE "CompanySuggestion" ADD COLUMN "summary" TEXT;
