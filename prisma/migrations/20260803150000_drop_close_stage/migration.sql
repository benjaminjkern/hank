-- Drop `closeStage`. It existed for one reader: grouping a company's CLOSED
-- roles on the shortlist board into "filtered on metadata" / "read in full" /
-- "closed at commit" / "you closed it". The board now shows only roles still
-- being considered — a decided role is off that screen entirely — so the column
-- had writers at five seams and nothing that read it.
--
-- No backfill: nothing consumed the values, and the close itself is still fully
-- described by the closeReason + closeNote that stay behind.

ALTER TABLE "JobInteraction" DROP COLUMN "closeStage";
DROP TYPE "CloseStage";
