-- Rename the per-role status enum InteractionStatus -> JobInteractionStatus so
-- the type name says WHICH interaction it belongs to. There are two interaction
-- tables (JobInteraction / CompanyInteraction) and the company one already has
-- its own status enum (CompanyStatus), so the unqualified name was the odd one
-- out.
--
-- METADATA-ONLY: ALTER TYPE ... RENAME TO renames the type in place. No values,
-- columns, or rows change (precedent: 20260622160000_rename_skipped_to_closed).
--
-- Ordering note: Prisma casts enum params by type name, so a client generated
-- from the renamed schema cannot query until this lands, and a client generated
-- before it cannot query after. Apply this and restart the dev server together.

ALTER TYPE "InteractionStatus" RENAME TO "JobInteractionStatus";
