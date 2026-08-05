// Shared utilities for walkthrough-pipeline scenarios. Each case file under
// scripts/scenarios/cases/ imports from here so the scenario itself stays
// focused on its setup / assertions / cleanup.
//
// Why per-file scenarios: the monolithic run.ts was approaching 1300 lines
// with 15 scenarios; merge conflicts on parallel agent work were getting
// expensive. Per-file scenarios = self-contained example + cheap to add.

import "dotenv/config";
import { prisma } from "@/server/db/prisma";
import { runChatTurn } from "@/server/procedures/registry/chat";
import { runWalkthrough } from "@/server/procedures/registry/walkthrough";

// Constants used by every scenario.

// The user the scenarios run against — set SCENARIOS_USER_ID in .env to an
// existing user's id (these scenarios read/write real rows for that user).
export const USER_ID = process.env.SCENARIOS_USER_ID ?? "";
// Dedicated scenario-test session. NOT the app's main chat session — keeping it
// separate means scenario-generated messages never bleed into the real
// conversation's replay context. `ensureTestSession()` upserts it + wipes
// prior scenario chatter at the start of each run so the table doesn't
// accumulate cruft across runs.
export const TEST_SESSION_ID = `scenarios-cli-${USER_ID}`;
// Most scenarios target the test session for picker/dispatch state. Bundled-
// action scenarios (defer / skip) still mutate JobInteraction + Event rows
// under the scenario user but restore status — Event rows accumulate as a known
// limitation (audit trail, not replayed to LLM).
export const SESSION_ID = TEST_SESSION_ID;

// endedAt set to epoch so getOrCreateActiveSession's `where: { endedAt: null }`
// filter ALWAYS excludes the test session — without this, the test session
// (newer than the user's real one) shadows it in the chat UI and the user
// opens the app to see scenario messages instead of their real chat.
const ENDED_AT_SENTINEL = new Date(0);

export async function ensureTestSession(): Promise<void> {
  await prisma.chatSession.upsert({
    where: { id: TEST_SESSION_ID },
    create: {
      id: TEST_SESSION_ID,
      userId: USER_ID,
      endedAt: ENDED_AT_SENTINEL,
    },
    // Re-stamp endedAt so the test session can never become "active".
    update: {
      endedAt: ENDED_AT_SENTINEL,
    },
  });
  await prisma.chatMessage.deleteMany({
    where: { sessionId: TEST_SESSION_ID },
  });
}

// Event record captured by drainStateMachine / drainPipeline. Open-ended
// `type` + sparse fields keeps scenarios from having to construct typed
// TurnEvent unions — they just look up text / kind / name as needed.
export type EventRecord = {
  type: string;
  text?: string;
  kind?: string;
  name?: string;
  calledTool?: boolean;
};

// Scenario return shape. `ok` means assertions held. `skipped` (when set)
// means the scenario's data prerequisites weren't met — counted separately
// in the summary line so "13/13 pass" can't silently include 5 SKIPs.
// When `skipped` is set, `ok` is ignored; convention is to also set ok=true
// so the scenario doesn't read as a failure if a caller forgets to branch.
export type ScenarioResult = {
  ok: boolean;
  notes: string[];
  skipped?: string;
};

export type Scenario = {
  name: string;
  describe: string;
  // "cheap" = Anthropic calls are limited to the walkthrough-agent (one
  // turn, ~$0.05). "expensive" = runs applicationDraftingSubAgent which fires
  // multiple sub-agent passes per question (~$0.30+ per run).
  cost: "cheap" | "expensive";
  // Save + restore session state around the run so scenarios don't leak.
  // Return ok=true if the scenario's assertions hold. Set `skipped` to a
  // short reason string when data prerequisites aren't met (e.g. "no MongoDB
  // SHORTLISTED job"); the summary counts skips separately.
  run: () => Promise<ScenarioResult>;
};

// Run the walkthrough state machine until exhaustion, collecting events for
// assertion. Uses SESSION_ID + USER_ID (the scenario sets focus via
// withFocus before calling this).
export async function drainStateMachine(): Promise<{
  events: EventRecord[];
  wrappedUp: boolean;
}> {
  const events: EventRecord[] = [];
  const gen = runWalkthrough({
    userId: USER_ID,
    sessionId: SESSION_ID,
    userMessage: "",
  });
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, wrappedUp: next.value.wrappedUp };
    const ev = next.value;
    if (ev.type === "text") events.push({ type: "text", text: ev.text });
    else if (ev.type === "pipeline_status")
      events.push({ type: "pipeline_status", text: ev.text });
    else if (ev.type === "pipeline_widget")
      events.push({ type: "pipeline_widget", kind: ev.kind });
    else events.push({ type: ev.type });
  }
}

// Run the walkthrough pipeline (which can include an LLM agent turn).
// Captures tool_use_start with the tool name so scenarios can assert which
// tool fired. Returns total + action-only tool-call counts; action tools
// are the mutating ones (skip/defer/switch/pick_next/edit_profile/add_companies).
export async function drainPipeline(userMessage: string): Promise<{
  events: EventRecord[];
  toolCalls: number;
  actionToolCalls: number;
}> {
  const events: EventRecord[] = [];
  let toolCalls = 0;
  // Read tools (read_memory / list_memories) shouldn't count
  // against "the agent answered with text only" assertions — the agent may
  // legitimately read context before replying.
  const ACTION_TOOL_NAMES = new Set([
    "close_company",
    "defer_company",
    "close_job",
    "defer_job",
    "switch_to_company",
    "pick_next_company",
    "switch_to_edit_profile",
    "add_companies_to_watchlist",
  ]);
  let actionToolCalls = 0;
  for await (const ev of runChatTurn({
    userId: USER_ID,
    sessionId: SESSION_ID,
    userMessage,
    attachmentIds: [],
  })) {
    if (ev.type === "text") events.push({ type: "text", text: ev.text });
    else if (ev.type === "pipeline_status")
      events.push({ type: "pipeline_status", text: ev.text });
    else if (ev.type === "pipeline_widget")
      events.push({ type: "pipeline_widget", kind: ev.kind });
    else if (ev.type === "tool_use_start") {
      toolCalls++;
      if (ACTION_TOOL_NAMES.has(ev.name)) actionToolCalls++;
      events.push({ type: "tool_use_start", name: ev.name });
    } else events.push({ type: ev.type });
  }
  return { events, toolCalls, actionToolCalls };
}

// Snapshot existing Event IDs for USER_ID before running `body`, then delete
// any Events that didn't exist in the snapshot after `body` returns —
// including on error. Catches the audit-trail droppings from bundled-action
// scenarios (deferJob writes a NOTE event; the scenario restores the
// JobInteraction status but not the Event). Without this, every run
// accumulates CLOSED / DEFERRED / NOTE rows in the user's JobInteraction
// event history.
export async function withEventCleanup<T>(body: () => Promise<T>): Promise<T> {
  const before = new Set(
    (
      await prisma.jobEvent.findMany({
        where: { jobInteraction: { userId: USER_ID } },
        select: { id: true },
      })
    ).map((e) => e.id),
  );
  try {
    return await body();
  } finally {
    const after = await prisma.jobEvent.findMany({
      where: { jobInteraction: { userId: USER_ID } },
      select: { id: true },
    });
    const newIds = after.filter((e) => !before.has(e.id)).map((e) => e.id);
    if (newIds.length > 0) {
      await prisma.jobEvent.deleteMany({ where: { id: { in: newIds } } });
    }
  }
}

// Focus is ephemeral now — there's no slot to set/restore. Kept as a thin
// pass-through so existing scenario call sites (which used to set focus) still
// compile; the focus arg is ignored. A scenario that drives the state machine
// directly passes an `entryTarget` to runWalkthrough instead.
export async function withFocus<T>(
  _focus: {
    focusedCompanyId: string | null;
    focusedJobId: string | null;
    focusedOpportunityId: string | null;
  },
  body: () => Promise<T>,
): Promise<T> {
  return await body();
}
