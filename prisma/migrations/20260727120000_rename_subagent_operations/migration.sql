-- Rename seven `operation` values so each is the snake_case of the sub-agent
-- that emits it — the third leg of the file ↔ export ↔ operation triple
-- (AGENTS.md → "One name per concept"). `operation` is a plain String column on
-- both tables, so this is pure data, no DDL.
--
-- Ships alongside the code that emits the new names. Nothing reads these values
-- to make a decision — they're telemetry for `pnpm usage` and the sub-agent
-- runtime audit — so the ordering isn't dangerous in either direction; it just
-- splits one sub-agent across two buckets until both halves land.
--
-- Only values whose sub-agent was renamed are listed. Retired keys that still
-- have rows but no emitter (whats_next, orchestrator_route, prescan_deep,
-- discovery_search, company_suggestions, name_extraction, users_distill) keep
-- their historical names on purpose: renaming a dead key to match a file that
-- no longer exists would make the row lie about what actually ran.

UPDATE "TokenUsage"  SET "operation" = 'application_critic'   WHERE "operation" = 'critique_application';
UPDATE "TokenUsage"  SET "operation" = 'application_decider'  WHERE "operation" = 'decide_application';
UPDATE "TokenUsage"  SET "operation" = 'application_drafting' WHERE "operation" = 'draft_application';
UPDATE "TokenUsage"  SET "operation" = 'compact_summary'      WHERE "operation" = 'compact_chat';
UPDATE "TokenUsage"  SET "operation" = 'logo_verifier'        WHERE "operation" = 'logo_verify';
UPDATE "TokenUsage"  SET "operation" = 'parse_resume'         WHERE "operation" = 'resume_parse';
UPDATE "TokenUsage"  SET "operation" = 'pre_scan_chunk'       WHERE "operation" = 'prescan';

UPDATE "SubAgentRun" SET "operation" = 'application_critic'   WHERE "operation" = 'critique_application';
UPDATE "SubAgentRun" SET "operation" = 'application_decider'  WHERE "operation" = 'decide_application';
UPDATE "SubAgentRun" SET "operation" = 'application_drafting' WHERE "operation" = 'draft_application';
UPDATE "SubAgentRun" SET "operation" = 'compact_summary'      WHERE "operation" = 'compact_chat';
UPDATE "SubAgentRun" SET "operation" = 'logo_verifier'        WHERE "operation" = 'logo_verify';
UPDATE "SubAgentRun" SET "operation" = 'parse_resume'         WHERE "operation" = 'resume_parse';
UPDATE "SubAgentRun" SET "operation" = 'pre_scan_chunk'       WHERE "operation" = 'prescan';
