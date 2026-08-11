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
// Keep it in the user's language. The wrap's consolidate + compact wait is never
// narrated — the user has no notes/transcript model, so naming those leaks
// internal jargon.

import {
  CompanyStatus,
  type ApplyChannel,
  type JobCloseReason,
  type CompanyBlockReason,
} from "@/generated/prisma/client";
import { formatFocusRefToken } from "@/lib/focusRefToken";
import { humanCompanyBlockReason } from "@/server/entities/companies/humanCompanyReasonLabels";
import { humanJobCloseReason } from "@/server/entities/jobs/humanJobReasonLabels";

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

// What the runner says when it puts a finished application on screen. The
// reviewer's own words lead — it read the writing and nothing deterministic can
// say what's in it — and every finding it couldn't settle is printed in full
// underneath, because a finding is only useful next to the words it objects to
// and the count alone told the user nothing they could act on.
//
// The frame is one sentence and holds only what the model has no way to know:
// what the button is called.
export function narrateApplicationReady(args: {
  note: string | null;
  openFindings: string[];
}): string {
  const parts: string[] = [];
  if (args.note?.trim()) parts.push(args.note.trim());
  if (args.openFindings.length > 0) {
    parts.push(
      args.openFindings.length === 1
        ? "One thing I couldn't settle on my own — it's yours to call:"
        : "A few things I couldn't settle on my own — they're yours to call:",
    );
    parts.push(args.openFindings.map((f) => `- ${f}`).join("\n"));
  }
  parts.push(
    "It's on the right — change anything that doesn't sound like you, and tap **I submitted ✓** once you've applied.",
  );
  return parts.join("\n\n");
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
