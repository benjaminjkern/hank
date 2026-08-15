// How a deterministic state change READS to the user. The entity writes return
// facts; this turns them into the one sentence the state machine yields as a
// `pipeline_status` before the panel events fire, so the chat history records
// what just happened alongside the visual side effect.
//
// Narration is required on every state change the machine makes — that's what
// keeps a silent mutation from slipping back in. It is deliberately NOT shared
// with the tools: a tool's `content` is written for Hank ("Closed (NOT_A_MATCH).
// Wrapped up this company…"), these are written for the user. Same event, two
// audiences, two strings.
//
// Keep it in the user's language. The wrap's consolidate + compact wait gets
// exactly one generic line ("Filing away what I learned…", yielded by runChat)
// — never the mechanism, since the user has no notes/transcript model and
// naming those leaks internal jargon.

import {
  CompanyStatus,
  type ApplyChannel,
  type JobCloseReason,
  type CompanyBlockReason,
} from "@/generated/prisma/client";
import { formatFocusRefToken } from "@/lib/focusRefToken";
import { humanCompanyBlockReason } from "@/server/entities/companies/humanCompanyReasonLabels";
import { humanJobCloseReason } from "@/server/entities/jobs/humanJobReasonLabels";
import type { CritiqueStop } from "@/server/procedures/registry/draftApplication/critiqueAndRevise";

// Appended to the company set-asides the machine performs so the user sees one
// coherent transition instead of [action] + [silent gap] + [next picker]. Same
// string across them so the post-action chrome reads consistently — the
// no-target reentry branch in dispatchByEntryTarget matches it.
const WRAP_DEBRIEF = " Pulling up what's next.";

const MAX_NOTE_CHARS = 80;

function noteSuffix(note?: string): string {
  const trimmed = note?.trim();
  if (!trimmed) return "";
  const clipped =
    trimmed.length > MAX_NOTE_CHARS
      ? `${trimmed.slice(0, MAX_NOTE_CHARS - 1)}…`
      : trimmed;
  return ` (${clipped})`;
}

// A clickable chip when we know the company, plain words when we don't.
function companyRef(companyId: string, companyName: string | null): string {
  return companyName
    ? formatFocusRefToken("company", companyId, companyName)
    : "this company";
}

export function narrateCompanyBlock(args: {
  companyId: string;
  companyName: string | null;
  reason: CompanyBlockReason;
  note?: string;
}): string {
  return `Set ${companyRef(args.companyId, args.companyName)} aside — ${humanCompanyBlockReason(args.reason)}.${noteSuffix(args.note)}${WRAP_DEBRIEF}`;
}

// Keyed off the status that actually landed, so this doesn't say "caught up"
// when there's an application in flight.
export function narrateCompanyCaughtUp(args: {
  companyId: string;
  companyName: string | null;
  status: CompanyStatus;
}): string {
  const ref = companyRef(args.companyId, args.companyName);
  const line =
    args.status === CompanyStatus.IN_PROCESS
      ? `Nice — ${ref} is in process (an application's moving forward).`
      : args.status === CompanyStatus.IN_FLIGHT
        ? `${ref} is in flight — application's in, waiting to hear back.`
        : `Marked ${ref} as caught up for now.`;
  return `${line}${WRAP_DEBRIEF}`;
}

// The tail of a round the user just settled themselves (a committed board, a
// submitted application). The commit already told them what closed, so this
// never re-litigates the decision — it says what the settle means for the
// company, keyed off the status that actually landed.
export function narrateCompanySettled(args: {
  companyId: string;
  companyName: string | null;
  status: CompanyStatus;
}): string {
  const ref = companyRef(args.companyId, args.companyName);
  const line =
    args.status === CompanyStatus.IN_PROCESS
      ? `That settles ${ref} — an application there is still moving forward, so it stays in process.`
      : args.status === CompanyStatus.IN_FLIGHT
        ? `That settles ${ref} — your application's in, so it waits in flight while you hear back.`
        : `That settles ${ref} — marked caught up. I'll flag anything new next time we look.`;
  return `${line}${WRAP_DEBRIEF}`;
}

export function narrateCompanyRevive(args: {
  companyId: string;
  companyName: string | null;
}): string {
  return `Reviving ${companyRef(args.companyId, args.companyName)} and checking the board for anything new.`;
}

export function narrateJobClose(args: {
  jobTitle: string | null;
  companyName: string | null;
  reason: JobCloseReason;
  note?: string;
}): string {
  return `Closed ${jobRef(args)} — ${humanJobCloseReason(args.reason)}.${noteSuffix(args.note)}`;
}

// What the runner says when it puts a finished application on screen: the
// reviewer's own line about the writing, then how the read-back ended.
//
// It does NOT restate the findings. Each one is drawn against the answer it
// objects to, and a finding read three paragraphs above the words it's about is
// the version that can't be acted on — so chat carries the count and the panel
// carries the text. What chat must not do is go quiet: a draft that arrives with
// no word on whether the read-back finished reads as finished either way, which
// is the one thing the user can't check for themselves.
export function narrateApplicationReady(args: {
  note: string | null;
  openCount: number;
  stop: CritiqueStop | null;
}): string {
  const parts: string[] = [];
  if (args.note?.trim()) parts.push(args.note.trim());
  parts.push(reviewEnding(args.openCount, args.stop));
  parts.push(
    "Change anything that doesn't sound like you, and tap **I submitted ✓** once you've applied.",
  );
  return parts.join("\n\n");
}

// Deliberately NOT "things I need from you" — that phrasing belongs to the items
// the decider couldn't draft at all, and using it here made a finished draft read
// as a request for more information. This is the opposite situation: the writing
// is done, and these are what to look at before it goes.
function reviewEnding(openCount: number, stop: CritiqueStop | null): string {
  if (openCount > 0) {
    const things =
      openCount === 1
        ? "one thing I'd look at, flagged on the right next to the answer it's about"
        : `${openCount} things I'd look at, flagged on the right next to the answers they're about`;
    return stop === "capped"
      ? `I've stopped rewriting rather than keep going in circles — there's ${things}.`
      : `I've taken this as far as I can on my own — there's ${things}.`;
  }
  switch (stop) {
    case "clean":
      return "I read the whole thing back and there's nothing left I'd change. It's on the right.";
    case "error":
      return "I couldn't finish reading it back just now, so treat it as unchecked — it's on the right.";
    default:
      return "I've taken this as far as I can on my own. It's on the right.";
  }
}

export function narrateJobApplied(args: {
  jobTitle: string | null;
  applyChannel: ApplyChannel;
}): string {
  const via = args.applyChannel === "RECRUITER" ? " via recruiter" : "";
  return `Logged ${args.jobTitle ?? "this job"} as applied${via}.`;
}

function jobRef(args: {
  jobTitle: string | null;
  companyName: string | null;
}): string {
  const at = args.companyName ? ` @ ${args.companyName}` : "";
  return `${args.jobTitle ?? "this job"}${at}`;
}
