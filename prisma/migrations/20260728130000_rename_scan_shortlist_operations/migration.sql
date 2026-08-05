-- Rename three `operation` values to follow their sub-agents:
--   preScanChunk  -> preScanJobBatch   (pre_scan_chunk -> pre_scan_job_batch)
--   scanMatch     -> scanJob           (scan_match     -> scan_job)
--   shortlistAuto -> shortlistJobs     (shortlist_auto -> shortlist_jobs)
--
-- Third leg of the file <-> export <-> operation triple (AGENTS.md -> "One name
-- per concept"). `operation` is a plain String column on both tables, so this is
-- pure data, no DDL. Same shape as 20260727120000_rename_subagent_operations.
--
-- Ships alongside the code that emits the new names. Nothing reads these values
-- to make a decision -- they're telemetry for `pnpm usage` and the sub-agent
-- runtime audit -- so the ordering isn't dangerous in either direction; it just
-- splits one sub-agent across two buckets until both halves land.
--
-- Row counts measured 2026-07-28 before applying:
--   TokenUsage  pre_scan_chunk 1424 | scan_match 9269 | shortlist_auto  503
--   SubAgentRun pre_scan_chunk  443 | scan_match 8495 | shortlist_auto   79
--
-- NOT renamed on purpose: the `propose_shortlist_auto` tool name persisted in
-- ChatMessage content is a different thing (a retired synthetic tool segment,
-- not this sub-agent) and stays as history.

UPDATE "TokenUsage"  SET "operation" = 'pre_scan_job_batch' WHERE "operation" = 'pre_scan_chunk';
UPDATE "TokenUsage"  SET "operation" = 'scan_job'           WHERE "operation" = 'scan_match';
UPDATE "TokenUsage"  SET "operation" = 'shortlist_jobs'     WHERE "operation" = 'shortlist_auto';

UPDATE "SubAgentRun" SET "operation" = 'pre_scan_job_batch' WHERE "operation" = 'pre_scan_chunk';
UPDATE "SubAgentRun" SET "operation" = 'scan_job'           WHERE "operation" = 'scan_match';
UPDATE "SubAgentRun" SET "operation" = 'shortlist_jobs'     WHERE "operation" = 'shortlist_auto';
