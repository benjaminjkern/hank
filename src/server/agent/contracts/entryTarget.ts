// The handoff contract between Hank's tools and the deterministic layer. Lives in
// agent/contracts/ rather than agent/tools/lib/ because the walkthrough state
// machine and the widget dispatchers both read and construct one — a tool
// returning it is only one of several producers.

// What the deterministic layer should run on THIS turn — the argument of a
// handoff. Threaded in memory (tool result / picker dispatch → runner → state
// machine) and NEVER persisted.
//
// It is the whole dispatch signal: there is no focus slot to read, so an entry
// that carries no target has nothing to run and falls through to "what's next".
// Continuity across turns rides on widget payloads (every picker/confirm carries
// its own ids) and, in free chat, on Hank re-supplying a slug.
//
// (Named FocusTarget when it first replaced the focus slot. It sets no focus and
// there is no focus — it names the entry point into the deterministic layer.)
export type EntryTarget =
  // `direction` is an optional free-text steer for the company's shortlist rung
  // ("infra roles only"). Present = the user wants a FRESH round on those terms,
  // so the rung skips its regen gate and re-ranks; absent = plain resume, which
  // no-ops past a shortlist that's already decided. Same contract as discovery's
  // `direction` below.
  | { kind: "company"; id: string; direction?: string }
  | { kind: "job"; id: string }
  | { kind: "opportunity"; id: string }
  // Discovery has no entity to point at yet — that's the point of it. `direction`
  // is the free-text steer Hank forwards from the conversation ("early-stage
  // infra"), or absent to work from the user's thesis alone. This is a
  // discriminated union, so a variant carrying no id is fine: every consumer
  // narrows on `kind` first.
  // `append` keeps what's already on the panel and adds to it. Absent (the
  // default) replaces it: a fresh search is normally a fresh list, and growing
  // the panel every time would bury the batch the user is looking at.
  | { kind: "discovery"; direction?: string; append?: boolean }
  // Settle the discovery list the user has been marking up. Its own variant
  // rather than a flag on `discovery`, because it enters a different arm: one
  // SEARCHES, the other COMMITS what the searching produced.
  | { kind: "discovery_commit" };
