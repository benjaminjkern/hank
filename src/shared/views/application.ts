// The application page's payload — every item the form asks for, in form
// order, with what's written for it and who wrote it. Built by
// loadApplicationView (server/views/application.ts).

import type {
  ApplicationEdit,
  DraftAuthor,
  DraftVerdict,
} from "@/shared/applicationDrafts";
import type {
  NegotiationRow,
  NegotiationState,
} from "@/shared/views/negotiationPanel";

export type ApplicationItemStatus =
  // The user wrote or reworked this text.
  | "written_by_you"
  // Hank's draft, untouched.
  | "drafted"
  // The decider wants the user's own input before anything is written.
  | "needs_you"
  // Nothing written. `note` says why, when Hank had a reason.
  | "empty";

export type ApplicationItem = NegotiationRow & {
  id: string;
  kind: "cover_letter" | "question";
  // "Cover letter", or the question as the form asks it.
  label: string;
  required: boolean;
  // "user" marks a question someone described by hand rather than one scraped
  // off the form — the panel badges it as unverified.
  source: "scraped" | "user";
  text: string | null;
  reuse: boolean | null;
  // Who wrote the text that's here, for the page's byline. Null when nothing is
  // written, or when nothing stamped it.
  author: DraftAuthor | null;
  status: ApplicationItemStatus;
  // What the pending change DID, in the same vocabulary the relay reports it to
  // Hank in — so the page's tag says "written" for text the user typed from
  // scratch rather than calling it an edit. Null when nothing is pending.
  change: ApplicationEdit["change"] | null;
  // Hank's one-line reason for leaving this alone, shown under an empty item.
  note: string | null;
  // What the decider ruled for this item. "skip" is the panel's cue to file it
  // under the fill-it-in-yourself tail instead of giving it an editor — a
  // person types their own LinkedIn URL faster than they read a draft of it.
  // Null when nothing has ruled on it: no draft pass has run AND the widget
  // type isn't a stock field.
  verdict: DraftVerdict | null;
  // This user described this question by hand, so they may reword it. A scraped
  // question is what the form actually says, and someone else's wording isn't
  // theirs to change — both render read-only.
  addedByYou: boolean;
  // What the review raised about THIS item, in the reviewer's own words,
  // sitting against the text it's about. `tone` is the whole of how it renders,
  // and it answers two questions at once — see FindingTone.
  findings: ApplicationFinding[];
};

// How one finding reads on the page. The split is not decoration: an objection
// to HANK's draft is a question he needs settled, and drawing it as a fault
// would be showing the user a warning about writing they didn't do. And a
// finding whose words have since changed doesn't disappear — it goes quiet and
// stays put until the relay carries it to him, so the user can see what their
// edit was answering instead of watching the reason for it vanish mid-edit.
export type FindingTone =
  // Open, on Hank's draft — quiet: he's asking about his own words.
  | "question"
  // Open, on the user's own words — the only one drawn as a fault.
  | "note"
  // The words it objected to are gone. Muted, and clears on the next message.
  | "answered";

export type ApplicationFinding = { note: string; tone: FindingTone };

export type ApplicationView = NegotiationState & {
  jobId: string;
  jobSlug: string | null;
  jobTitle: string;
  jobStatus: string;
  // The posting itself — where the user actually submits.
  postingUrl: string | null;
  company: { id: string; slug: string; name: string; logoUrl: string } | null;
  companyName: string;
  // Applied and onwards: the page stays editable (the text is reusable
  // elsewhere) but stops relaying edits and stops offering submit.
  submitted: boolean;
  // The form couldn't be read AND nobody described a question by hand.
  formUnreadable: boolean;
  // Read, and it genuinely asks nothing beyond the stock fields.
  formEmpty: boolean;
  // The form takes a cover letter (so the page offers one unprompted).
  wantsCoverLetter: boolean;
  items: ApplicationItem[];
};
