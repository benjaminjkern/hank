-- Discovery moves from a chat checklist to a right-panel surface, so a
-- candidate now carries a user MARK (persisted on click, relayed to Hank on the
-- next message) separately from the VERDICT that commit_discovery settles.
--
-- `relayedMark` is what Hank has been told; its divergence from `userMark` is
-- the unrelayed-edit test, mirroring the board's userVerdict/placementVerdict.

CREATE TYPE "CompanySuggestionMark" AS ENUM ('ADD', 'PASS');

ALTER TABLE "CompanySuggestion"
  ADD COLUMN "userMark"    "CompanySuggestionMark",
  ADD COLUMN "relayedMark" "CompanySuggestionMark",
  ADD COLUMN "markedAt"    TIMESTAMP(3);
