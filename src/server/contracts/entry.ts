import type { RunContext } from "@/server/platform/runContext";

import type { Say } from "./events";

// What runs next, and how a step says so — the whole routing vocabulary of one
// chat message.
//
// An Entry names a procedure to run and the arguments it needs. Four things
// produce one: a widget answer or panel commit (the user clicked), a handoff
// tool (Hank queued it), a step that finished (it handed off), and the chat loop
// itself when a message has nothing else to run on. Each kind is named for the
// procedure it enters — which, where Hank can queue it, is also his tool's name.
//
// Never persisted. A procedure that needs the user ends the message; their
// answer comes back as a new message and re-enters through an Entry, and every
// procedure re-derives its position from the database rather than from a step
// number. That is what keeps the queue from outliving the message.
export type Entry =
  // Walk one company's ladder. `direction` is a free-text steer for its
  // shortlist rung ("infra roles only"): present means a FRESH round on those
  // terms, absent means plain resume. `continuation` marks the tail of work
  // already in motion there (a commit, a submitted application) — it surfaces
  // what exists and never starts work, so the board-scrape rung is skipped.
  // `revive` is the user's yes to bringing a CLOSED / BLOCKED company back:
  // without it the walkthrough asks; with it the walkthrough revives.
  | {
      kind: "company_walkthrough";
      companyId: string;
      direction?: string;
      continuation?: true;
      revive?: true;
    }
  // Work one role: form → draftable answers → self-review → wait for submit.
  // `freshEntry` = the user deliberately picked it this message, so a role with
  // nothing left to draft still says where it stands instead of going silent.
  | { kind: "work_on_job"; jobId: string; freshEntry?: true }
  // A lead with no company yet. Nothing runs for it beyond putting it on screen.
  | { kind: "opportunity"; opportunityId: string }
  // Search for companies and put them on the discovery panel. `direction` is
  // Hank's steer; `append` keeps the list on screen and adds to it (absent
  // replaces it — a fresh search is normally a fresh list).
  | { kind: "find_companies"; direction?: string; append?: boolean }
  // Settle the discovery list the user has been marking up.
  | { kind: "commit_discovery" }
  // The between-things chooser — or, when the profile is still too thin to
  // match against, Hank asking for what's missing. Named for Hank's tool.
  | { kind: "show_whats_next" }
  // Hank takes the next turn. Answering the user's own message carries no
  // `nudge`; anything else does — a synthetic opening instruction (never
  // persisted, parenthesized so he reads it as an instruction, not words to
  // echo), because there is no user row for him to answer.
  | { kind: "hank"; nudge?: string; profileGaps?: ProfileGaps };

// The profile gate's read of what's thin (weakest slots + probe questions), so
// Hank opens on the specifics instead of cold.
export type ProfileGaps = { missing: string[]; suggestedProbes: string[] };

// A stretch of work that ended this message, so the chat loop files away what it
// revealed once the message is done.
export type Segment = "company" | "discovery";

// How every step of a message ends: by naming what runs next, or by leaving the
// user something to answer (no `next`). `ended` is a FACT about a write the step
// made, not routing — it never decides what runs; the chat loop reads it after
// the chain to run the wrap-up once. `stopped` means the user hit Stop.
export type StepOutcome = {
  next?: Entry;
  ended?: Segment;
  stopped?: true;
};

// What every step is handed: the ambient run, the session, and the one `say`
// it narrates through. A step's own inputs ride on its Entry.
export type StepArgs = RunContext & { sessionId: string; say: Say };
