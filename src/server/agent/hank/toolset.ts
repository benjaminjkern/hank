// Hank's tool list — ONE list, no per-flow filter. Every tool here is safe to
// call at any point in a conversation: each resolves its own target by slug and
// writes only that target, so there is no ordering a wrong call can corrupt.
//
// What's deliberately ABSENT is work the deterministic layer drives itself —
// application drafting runs from the walkthrough job-arm, not from a Hank tool.
//
// Also absent, on purpose: the five SUB-AGENT ONLY tools. They live in the same
// registry (one file per tool, wherever it's used) but are handed only to the
// sub-agents that need them, via each SubAgentDef's `readTools`:
//   probe_ats, test_scrape      — company_basic_info's board hunt
//   test_recipe                 — board_recipe's recon
//   fetch_url                   — company_basic_info, board_recipe, find_companies
//   read_reusable_application   — application_drafting's voice match
// Don't add them here.

// One import per tool — the flat registry lives in @/server/tools/, one
// file per callable tool. Shared helper modules beside it in lib/ are infra,
// not tools.
import type { AnyToolDef } from "@/server/tools/lib/types";
import { addApplicationQuestionTool } from "@/server/tools/registry/addApplicationQuestion";
import { attachContactToOpportunityTool } from "@/server/tools/registry/attachContactToOpportunity";
import { attachResumeToProfileTool } from "@/server/tools/registry/attachResumeToProfile";
import { blockCompanyTool } from "@/server/tools/registry/blockCompany";
import { caughtUpCompanyTool } from "@/server/tools/registry/caughtUpCompany";
import { closeCompanyTool } from "@/server/tools/registry/closeCompany";
import { closeJobTool } from "@/server/tools/registry/closeJob";
import { commitDiscoveryTool } from "@/server/tools/registry/commitDiscovery";
import { recommendCompanyForDeletionTool } from "@/server/tools/registry/recommendCompanyForDeletion";
import { commitProfileTool } from "@/server/tools/registry/commitProfile";
import { commitShortlistTool } from "@/server/tools/registry/commitShortlist";
import { companyWalkthroughTool } from "@/server/tools/registry/companyWalkthrough";
import { createCompaniesTool } from "@/server/tools/registry/createCompanies";
import { createContactTool } from "@/server/tools/registry/createContact";
import { createJobsTool } from "@/server/tools/registry/createJobs";
import { createOpportunitiesTool } from "@/server/tools/registry/createOpportunities";
import { deferJobTool } from "@/server/tools/registry/deferJob";
import { deleteCompanyEventTool } from "@/server/tools/registry/deleteCompanyEvent";
import { deleteJobEventTool } from "@/server/tools/registry/deleteJobEvent";
import { deleteOpportunityEventTool } from "@/server/tools/registry/deleteOpportunityEvent";
import { draftApplicationTool } from "@/server/tools/registry/draftApplication";
import { draftApplicationQuestionTool } from "@/server/tools/registry/draftApplicationQuestion";
import { editCompanyEventTool } from "@/server/tools/registry/editCompanyEvent";
import { editJobEventTool } from "@/server/tools/registry/editJobEvent";
import { editOpportunityEventTool } from "@/server/tools/registry/editOpportunityEvent";
import { enrichCompaniesTool } from "@/server/tools/registry/enrichCompanies";
import { findCompaniesTool } from "@/server/tools/registry/findCompanies";
import { listCompaniesTool } from "@/server/tools/registry/listCompanies";
import { listCompanyEventsTool } from "@/server/tools/registry/listCompanyEvents";
import { listContactsTool } from "@/server/tools/registry/listContacts";
import { listJobEventsTool } from "@/server/tools/registry/listJobEvents";
import { listJobsTool } from "@/server/tools/registry/listJobs";
import { listMemoriesTool } from "@/server/tools/registry/listMemories";
import { listOpportunitiesTool } from "@/server/tools/registry/listOpportunities";
import { listOpportunityEventsTool } from "@/server/tools/registry/listOpportunityEvents";
import { logCompanyEventsTool } from "@/server/tools/registry/logCompanyEvents";
import { logJobEventsTool } from "@/server/tools/registry/logJobEvents";
import { logOpportunityEventsTool } from "@/server/tools/registry/logOpportunityEvents";
import { markJobAppliedTool } from "@/server/tools/registry/markJobApplied";
import { pauseCompanyTool } from "@/server/tools/registry/pauseCompany";
import { readApplicationDraftsTool } from "@/server/tools/registry/readApplicationDrafts";
import { readJobDescriptionTool } from "@/server/tools/registry/readJobDescription";
import { readMemoryTool } from "@/server/tools/registry/readMemory";
import { recommendJobForDeletionTool } from "@/server/tools/registry/recommendJobForDeletion";
import { reviewApplicationTool } from "@/server/tools/registry/reviewApplication";
import { saveApplicationAnswerTool } from "@/server/tools/registry/saveApplicationAnswer";
import { scrapeJobsForCompanyTool } from "@/server/tools/registry/scrapeJobsForCompany";
import { showApplicationTool } from "@/server/tools/registry/showApplication";
import { showCompanyTool } from "@/server/tools/registry/showCompany";
import { showDiscoveryTool } from "@/server/tools/registry/showDiscovery";
import { showJobTool } from "@/server/tools/registry/showJob";
import { showOpportunityTool } from "@/server/tools/registry/showOpportunity";
import { showShortlistBoardTool } from "@/server/tools/registry/showShortlistBoard";
import { showWhatsNextTool } from "@/server/tools/registry/showWhatsNext";
import { untrackCompanyTool } from "@/server/tools/registry/untrackCompany";
import { untrackJobTool } from "@/server/tools/registry/untrackJob";
import { updateCompanyTool } from "@/server/tools/registry/updateCompany";
import { updateCompanyInteractionTool } from "@/server/tools/registry/updateCompanyInteraction";
import { updateContactTool } from "@/server/tools/registry/updateContact";
import { updateDiscoveryProposalTool } from "@/server/tools/registry/updateDiscoveryProposal";
import { updateJobTool } from "@/server/tools/registry/updateJob";
import { updateJobInteractionTool } from "@/server/tools/registry/updateJobInteraction";
import { updateOpportunityTool } from "@/server/tools/registry/updateOpportunity";
import { updateShortlistProposalTool } from "@/server/tools/registry/updateShortlistProposal";
import { viewApplicationQuestionsTool } from "@/server/tools/registry/viewApplicationQuestions";
import { workOnJobTool } from "@/server/tools/registry/workOnJob";
import { writeMemoryTool } from "@/server/tools/registry/writeMemory";

// Every tool Hank can call. write_memory is safe here because validatePath
// gates by path, not by any notion of what Hank is "in the middle of."
const HANK_TOOLS: AnyToolDef[] = [
  // Reads
  readMemoryTool as AnyToolDef,
  listMemoriesTool as AnyToolDef,
  // Memory writes (path-gated)
  writeMemoryTool as AnyToolDef,
  // Profile shape changes that can happen from any flow (mid-walkthrough "here's
  // my updated resume" etc.).
  attachResumeToProfileTool as AnyToolDef,
  // Hand the baton to the deterministic layer for a named company — it runs that
  // company's arm (read the board → scan → shortlist). handoff.
  companyWalkthroughTool as AnyToolDef,
  // "The user says profile setup is done": consolidates memory + runs the verdict
  // gate. Shared like every other tool.
  commitProfileTool as AnyToolDef,
  // Grow the watchlist: hands off to the discovery arm, which runs the merged
  // discovery sub-agent (thesis + resume + watchlist signal + optional free-text
  // direction; web search available) and puts a checklist of candidates on
  // screen. For companies the user NAMED, Hank uses create_companies instead.
  findCompaniesTool as AnyToolDef,
  // Hand back so the "what's next" chooser comes up. handoff with no target:
  // the machine's no-target branch wraps and the chooser renders through the
  // same path a close/pause wrap uses. For "the user's done with the
  // current thing and wants to see their options" where nothing gets closed —
  // NOT a substitute for close/pause/block/caught_up_company — those bring the
  // chooser up on their own, so never follow one with show_whats_next.
  showWhatsNextTool as AnyToolDef,
  // Focus a specific role + hand off to the application workflow — the prose
  // counterpart to tapping a role in the next-role picker. For "let's do the X
  // role" / "first one's fine". handoff: the walkthrough job arm owns what shows
  // next (drafting → submit prompt). Distinct from view_application_questions
  // (read-only inspection — it can't start drafting).
  workOnJobTool as AnyToolDef,
  // Presentational display tools — put an entity's page on the user's screen +
  // drop a clickable chip in chat, without starting any work or changing state.
  // The "just look at this" counterparts to company_walkthrough / work_on_job.
  showCompanyTool as AnyToolDef,
  showDiscoveryTool as AnyToolDef,
  showJobTool as AnyToolDef,
  showOpportunityTool as AnyToolDef,
  // The shortlist-board trio. show_ is the display + full read (all tiers,
  // closed rows included); update_shortlist_proposal moves ONE role's stance
  // (negotiation state only — also the reconsider path for a role an earlier
  // pass set aside); commit_shortlist ends the negotiation and is the ONE
  // handoff of the three (the role picker follows deterministically).
  showShortlistBoardTool as AnyToolDef,
  showApplicationTool as AnyToolDef,
  updateShortlistProposalTool as AnyToolDef,
  commitShortlistTool as AnyToolDef,
  // Discovery's equivalent, and the same pair: update_discovery_proposal moves
  // ONE company's mark (and naming one not on the list is how it joins), while
  // commit_discovery settles the whole list — a handoff that writes, because
  // settling the list IS entering the continuation.
  updateDiscoveryProposalTool as AnyToolDef,
  commitDiscoveryTool as AnyToolDef,
  // Additive CRUD — the reason for the merge. Captures spontaneous info
  // (past applications, recruiter pitches, contacts) without dead-ending.
  createCompaniesTool as AnyToolDef,
  updateCompanyTool as AnyToolDef,
  listCompaniesTool as AnyToolDef,
  // Scrape a company's live board for new postings ("any new roles?", "look
  // again"). Distinct from company_walkthrough, which reads jobs already on
  // file. handoff: an explicit hand-off to the walkthrough pipeline — after the
  // scrape, the state machine scans + shortlists the new survivors, narrated.
  // See scrapeJobsForCompany.ts.
  scrapeJobsForCompanyTool as AnyToolDef,
  // Correct a company's stored status / reason on the watchlist row — the
  // company twin of update_job_interaction. Pure record fix: no activity-feed
  // entry, no revive, no re-scan, no touching its roles. NON-handoff, so a
  // "mark these three as caught up" is three calls in one turn (which is why
  // there's no bulk status tool).
  updateCompanyInteractionTool as AnyToolDef,
  // Full basic-info hunt + logo check from scratch ("this is the wrong careers
  // page / wrong logo / wrong company"). Distinct from scrape_jobs_for_company (which only pulls
  // new postings off the existing board).
  enrichCompaniesTool as AnyToolDef,
  createJobsTool as AnyToolDef,
  updateJobTool as AnyToolDef,
  // Read one role's full posting text (auto-promotes NEW/PITCHED → SCANNED).
  // list_job_events is the cheaper history-only read.
  readJobDescriptionTool as AnyToolDef,
  // The job event CRUD quartet — list (paginated, emits event ids) / log / edit /
  // delete. edit + delete target an event by its id (from list_job_events), so
  // repeated same-type events are addressable (no "most recent of type" latching).
  listJobEventsTool as AnyToolDef,
  listJobsTool as AnyToolDef,
  logJobEventsTool as AnyToolDef,
  editJobEventTool as AnyToolDef,
  deleteJobEventTool as AnyToolDef,
  // The company event CRUD quartet — parallel to the job one, over the company
  // "Recent activity" feed. Fully open: log any CompanyEventType; edit/delete
  // target a feed row by its id (from list_company_events).
  listCompanyEventsTool as AnyToolDef,
  logCompanyEventsTool as AnyToolDef,
  editCompanyEventTool as AnyToolDef,
  deleteCompanyEventTool as AnyToolDef,
  markJobAppliedTool as AnyToolDef,
  // Close / pause a company or role mid-conversation. The user can say "pass on
  // them" / "set this aside" at any point and it must land, not dead-end with
  // "unknown tool" (which Hank narrated as success).
  //
  // NONE of these are `handoff`. They're mutations, not entries into a
  // sequence — ending Hank's turn on one would cut his reply off mid-sentence
  // and cap "close these three" at one company. The company-level ones report
  // `endedCompanyId`, off which runUserMessage runs the segment wrap once per
  // message; close_job / defer_job are per-row and end no company.
  closeCompanyTool as AnyToolDef,
  pauseCompanyTool as AnyToolDef,
  // Block a company (couldn't read its board) — a TECHNICAL set-aside, never a
  // fit judgment, and revivable.
  blockCompanyTool as AnyToolDef,
  closeJobTool as AnyToolDef,
  deferJobTool as AnyToolDef,
  // Mark a company caught-up ("seen everything, keep watching") — its own lever,
  // so "mark as caught up" doesn't mis-map onto pause.
  caughtUpCompanyTool as AnyToolDef,
  // Destructive cleanup — for "I added this by mistake" / "this is junk from the
  // scraper", distinct from the close/pause soft-set-aside levers above (which
  // keep the history). untrack_* HARD-DELETE this user's own tracking: untrack_job
  // drops one JobInteraction + its events; untrack_company drops the watchlist entry
  // AND every role JobInteraction at that company. recommend_*_for_deletion don't
  // delete — they FLAG the shared global row (posting / company) for an admin to
  // approve or dismiss at /admin/deletions. All four are pure one-shot mutations
  // (no wrap, no handoff), safe to share so the "this shouldn't be here" case
  // lands from any flow instead of dead-ending.
  untrackJobTool as AnyToolDef,
  untrackCompanyTool as AnyToolDef,
  recommendJobForDeletionTool as AnyToolDef,
  recommendCompanyForDeletionTool as AnyToolDef,
  updateJobInteractionTool as AnyToolDef,
  // Read the cover letter + short answers already drafted for a job (pass the
  // role's slug; reads any job's drafts, not just the one on screen).
  // Shared so "what did I write for the Stripe role?" works from any flow —
  // Hank had no read path before, only the write tools.
  readApplicationDraftsTool as AnyToolDef,
  // Application drafting through the workflow (not chat prose). view_ lists the
  // form's questions + draft status and mints the questionIds; draft_application
  // runs the whole workflow for a job; draft_application_question (re)drafts ONE
  // item with the user's context; add_application_question registers a question
  // when the form couldn't be scraped. Shared so they work from any flow; they
  // resolve by slug or focus so they can't corrupt a flow.
  viewApplicationQuestionsTool as AnyToolDef,
  draftApplicationTool as AnyToolDef,
  draftApplicationQuestionTool as AnyToolDef,
  addApplicationQuestionTool as AnyToolDef,
  createOpportunitiesTool as AnyToolDef,
  updateOpportunityTool as AnyToolDef,
  // The lead event CRUD quartet — parallel to the job/company ones. edit/delete
  // target an event by its id (from list_opportunity_events).
  logOpportunityEventsTool as AnyToolDef,
  listOpportunityEventsTool as AnyToolDef,
  editOpportunityEventTool as AnyToolDef,
  deleteOpportunityEventTool as AnyToolDef,
  attachContactToOpportunityTool as AnyToolDef,
  createContactTool as AnyToolDef,
  updateContactTool as AnyToolDef,
  listOpportunitiesTool as AnyToolDef,
  listContactsTool as AnyToolDef,
  // Co-write persist primitive — merge-upserts one answer at a time so the
  // collaborative drafting flow doesn't clobber sibling answers and the job arm
  // can auto-detect completion. Resolves its job by slug and touches only that
  // job's answers, so there's nothing for it to corrupt from an unrelated turn.
  reviewApplicationTool as AnyToolDef,
  saveApplicationAnswerTool as AnyToolDef,
];

export function hankTools(): AnyToolDef[] {
  return [...HANK_TOOLS];
}

// Names of tools flagged `handoff: true` (see ToolDef.handoff). Derived from the
// tool defs so a new routing tool is picked up automatically by setting the flag
// — no hardcoded name list to keep in sync. The runner stops its agent loop after
// a turn that called one of these (the deterministic layer owns what shows next).
const HANDOFF_TOOLS: ReadonlySet<string> = new Set(
  HANK_TOOLS.filter((t) => t.handoff === true).map((t) => t.name),
);

// True if any tool_use block in this turn's content called a handoff tool.
export function turnCalledHandoffTool(
  content: ReadonlyArray<{ type: string; name?: string }>,
): boolean {
  return content.some(
    (b) => b.type === "tool_use" && !!b.name && HANDOFF_TOOLS.has(b.name),
  );
}
