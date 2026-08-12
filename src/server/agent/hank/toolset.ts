// Hank's tool list — ONE list, no per-flow filter. Every tool here is safe to
// call at any point in a conversation: each resolves its own target by slug and
// writes only that target, so there is no ordering a wrong call can corrupt.
//
// What's deliberately ABSENT is work the deterministic layer drives itself —
// application drafting runs from the walkthrough job-arm, not from a Hank tool.

// One import per tool — the flat registry lives in @/server/agent/tools/, one
// file per callable tool. Shared helper modules beside it in lib/ are infra,
// not tools.
import type { AnyToolDef } from "@/server/agent/tools/lib/types";
import { addApplicationQuestionTool } from "@/server/agent/tools/registry/addApplicationQuestion";
import { createOpportunitiesTool } from "@/server/agent/tools/registry/createOpportunities";
import { updateOpportunityTool } from "@/server/agent/tools/registry/updateOpportunity";
import { logOpportunityEventsTool } from "@/server/agent/tools/registry/logOpportunityEvents";
import { listOpportunityEventsTool } from "@/server/agent/tools/registry/listOpportunityEvents";
import { editOpportunityEventTool } from "@/server/agent/tools/registry/editOpportunityEvent";
import { deleteOpportunityEventTool } from "@/server/agent/tools/registry/deleteOpportunityEvent";
import { attachContactToOpportunityTool } from "@/server/agent/tools/registry/attachContactToOpportunity";
import { attachResumeToProfileTool } from "@/server/agent/tools/registry/attachResumeToProfile";
import { listOpportunitiesTool } from "@/server/agent/tools/registry/listOpportunities";
import { updateContactTool } from "@/server/agent/tools/registry/updateContact";
import { listContactsTool } from "@/server/agent/tools/registry/listContacts";
import { listCompaniesTool } from "@/server/agent/tools/registry/listCompanies";
import { createCompaniesTool } from "@/server/agent/tools/registry/createCompanies";
import { updateCompanyTool } from "@/server/agent/tools/registry/updateCompany";
import { blockCompanyTool } from "@/server/agent/tools/registry/blockCompany";
import { caughtUpCompanyTool } from "@/server/agent/tools/registry/caughtUpCompany";
import { companyWalkthroughTool } from "@/server/agent/tools/registry/companyWalkthrough";
import { pauseCompanyTool } from "@/server/agent/tools/registry/pauseCompany";
import { deferJobTool } from "@/server/agent/tools/registry/deferJob";
import { closeCompanyTool } from "@/server/agent/tools/registry/closeCompany";
import { closeJobTool } from "@/server/agent/tools/registry/closeJob";
import { findCompaniesTool } from "@/server/agent/tools/registry/findCompanies";
import { showWhatsNextTool } from "@/server/agent/tools/registry/showWhatsNext";
import { workOnJobTool } from "@/server/agent/tools/registry/workOnJob";
import { showCompanyTool } from "@/server/agent/tools/registry/showCompany";
import { showDiscoveryTool } from "@/server/agent/tools/registry/showDiscovery";
import { showJobTool } from "@/server/agent/tools/registry/showJob";
import { showOpportunityTool } from "@/server/agent/tools/registry/showOpportunity";
import { showShortlistBoardTool } from "@/server/agent/tools/registry/showShortlistBoard";
import { showApplicationTool } from "@/server/agent/tools/registry/showApplication";
import { updateShortlistProposalTool } from "@/server/agent/tools/registry/updateShortlistProposal";
import { commitDiscoveryTool } from "@/server/agent/tools/registry/commitDiscovery";
import { updateDiscoveryProposalTool } from "@/server/agent/tools/registry/updateDiscoveryProposal";
import { commitShortlistTool } from "@/server/agent/tools/registry/commitShortlist";
import { untrackJobTool } from "@/server/agent/tools/registry/untrackJob";
import { untrackCompanyTool } from "@/server/agent/tools/registry/untrackCompany";
import { recommendJobForDeletionTool } from "@/server/agent/tools/registry/recommendJobForDeletion";
import { recommendCompanyForDeletionTool } from "@/server/agent/tools/registry/recommendCompanyForDeletion";
import { commitProfileTool } from "@/server/agent/tools/registry/commitProfile";
import { createContactTool } from "@/server/agent/tools/registry/createContact";
import { createJobsTool } from "@/server/agent/tools/registry/createJobs";
import { deleteCompanyEventTool } from "@/server/agent/tools/registry/deleteCompanyEvent";
import { deleteJobEventTool } from "@/server/agent/tools/registry/deleteJobEvent";
import { draftApplicationTool } from "@/server/agent/tools/registry/draftApplication";
import { draftApplicationQuestionTool } from "@/server/agent/tools/registry/draftApplicationQuestion";
import { editCompanyEventTool } from "@/server/agent/tools/registry/editCompanyEvent";
import { editJobEventTool } from "@/server/agent/tools/registry/editJobEvent";
import { enrichCompaniesTool } from "@/server/agent/tools/registry/enrichCompanies";
import { listCompanyEventsTool } from "@/server/agent/tools/registry/listCompanyEvents";
import { listJobEventsTool } from "@/server/agent/tools/registry/listJobEvents";
import { listJobsTool } from "@/server/agent/tools/registry/listJobs";
import { listMemoriesTool } from "@/server/agent/tools/registry/listMemories";
import { logCompanyEventsTool } from "@/server/agent/tools/registry/logCompanyEvents";
import { logJobEventsTool } from "@/server/agent/tools/registry/logJobEvents";
import { markJobAppliedTool } from "@/server/agent/tools/registry/markJobApplied";
import { readApplicationDraftsTool } from "@/server/agent/tools/registry/readApplicationDrafts";
import { readJobDescriptionTool } from "@/server/agent/tools/registry/readJobDescription";
import { readMemoryTool } from "@/server/agent/tools/registry/readMemory";
import { reviewApplicationTool } from "@/server/agent/tools/registry/reviewApplication";
import { saveApplicationAnswerTool } from "@/server/agent/tools/registry/saveApplicationAnswer";
import { scrapeJobsForCompanyTool } from "@/server/agent/tools/registry/scrapeJobsForCompany";
import { updateCompanyInteractionTool } from "@/server/agent/tools/registry/updateCompanyInteraction";
import { updateJobTool } from "@/server/agent/tools/registry/updateJob";
import { updateJobInteractionTool } from "@/server/agent/tools/registry/updateJobInteraction";
import { viewApplicationQuestionsTool } from "@/server/agent/tools/registry/viewApplicationQuestions";
import { writeMemoryTool } from "@/server/agent/tools/registry/writeMemory";

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
