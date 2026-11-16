// Single source of truth for the widget-kind union. Both server (pipeline
// runners, runUserMessage) and client (chatStore, PipelineWidgetSlot) import
// from here so adding / removing a widget kind is a one-file change instead
// of two-must-stay-in-sync.
//
// Two subsets exist as type aliases for documentation, but every emission /
// dispatch site uses the full WidgetKind union — there's no enforcement gate
// that says "only PIPELINE_WIDGET_KINDS may be yielded as pipeline_widget."
// The subsets are descriptive, not prescriptive.

// A kind that's no longer here can still turn up in old persisted history.
// Everything that reads a kind off a stored block treats one it doesn't know as
// retired — the client shows a short "older question" note, Hank's replay a
// line saying so — rather than failing on it.
export type WidgetKind =
  // Emitted once a discovery commit has finished: names what landed and asks
  // whether to keep hunting. "yes" hands Hank the turn to ask what to look for,
  // "no" brings up what's next.
  | "add_more_companies"
  // Emitted during a discovery add when the URL hunter couldn't tell which of
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
  // The between-things chooser, emitted by the show_whats_next entry.
  | "next_company_picker"
  // Emitted by the company walkthrough after
  // SCANNED jobs have been triaged. Replaces the silent auto-focus onto the
  // stalest SHORTLISTED job — the user picks which to work on next (incl.
  // DEFERRED rows that get revived on pick).
  | "next_job_picker";
