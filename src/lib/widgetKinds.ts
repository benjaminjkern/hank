// Single source of truth for the widget-kind union. Both server (pipeline
// runners, runUserMessage) and client (chatStore, PipelineWidgetSlot) import
// from here so adding / removing a widget kind is a one-file change instead
// of two-must-stay-in-sync.
//
// Two subsets exist as type aliases for documentation, but every emission /
// dispatch site uses the full WidgetKind union — there's no enforcement gate
// that says "only PIPELINE_WIDGET_KINDS may be yielded as pipeline_widget."
// The subsets are descriptive, not prescriptive.

export type WidgetKind =
  // REPLAY-ONLY (docs/INCOMPLETE_MIGRATIONS.md): nothing emits it — the
  // shortlist board panel replaced the widget. The kind survives because
  // persisted `pipeline_widget` blocks in old sessions carry it verbatim.
  | "shortlist_proposal"
  // REPLAY-ONLY (docs/INCOMPLETE_MIGRATIONS.md): nothing emits it — the
  // discovery panel replaced the checklist. The kind survives because persisted
  // `pipeline_widget` blocks in old sessions carry it verbatim.
  | "company_checklist"
  // Emitted once a checklist add has finished: names what landed and asks
  // whether to keep hunting. "yes" re-enters the search, "no" falls through to
  // the what's-next picker.
  | "add_more_companies"
  // Emitted during a checklist add when the URL hunter couldn't tell which of
  // several real companies a name meant. The user picks which company
  // each ambiguous name refers to; the pick commits the chosen board.
  | "company_disambiguation"
  // Emitted by company_walkthrough when the user names a company that was
  // previously set aside (CLOSED — usually auto-skipped by the prescan, not a
  // deliberate user skip). Asks "Revive <Company> and continue?" — yes un-skips
  // the company + its roles and walks through it; no falls back to the
  // next-company picker. The "I want this one" override for an auto-skip.
  | "confirm_revive_company"
  | "confirm_application_submit"
  // The between-things chooser, emitted by renderWhatsNext.
  | "next_company_picker"
  // Emitted by the walkthrough state machine inside a company arm after
  // SCANNED jobs have been triaged. Replaces the silent auto-focus onto the
  // stalest SHORTLISTED job — the user picks which to work on next (incl.
  // DEFERRED rows that get revived on pick).
  | "next_job_picker"
  // REPLAY-ONLY, same as shortlist_proposal: the board's "not read yet" tier
  // (scan gate) and its re-show/re-seed behavior (regen gate) replaced both
  // questions. Kinds survive for persisted blocks in old sessions.
  | "shortlist_scan_gate"
  | "shortlist_regen_gate";
