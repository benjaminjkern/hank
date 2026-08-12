// The one sentence every sub-agent field whose text lands on a SURFACE carries.
//
// Third person is what leaks, and it leaks because the INPUTS are written that
// way: `profile.md` opens "Benjamin is targeting leadership roles", so a field
// that doesn't say otherwise gets it mirrored straight back out as "matches the
// user's thesis" — machine text about a third party, printed next to a company
// on the user's own screen.
//
// It exists as a constant because the rule was already spelled out verbatim in
// two sub-agents and missing from four others, one of which taught the wrong
// voice by EXAMPLE. A rule stated per-file is a rule that drifts per-file.
//
// **This is for text written TO the user, never text written AS them.** A cover
// letter and a short answer are first-person in the candidate's voice; appending
// this to those fields would break the thing they exist to do.
export const USER_FACING_VOICE =
  "VOICE: address the reader as 'you' / 'your' — never by name, and never as 'the user' / 'the candidate'. This string is printed on their screen, so 'outside the user's scope' or 'the candidate wants backend' reads as machine text about someone else.";
