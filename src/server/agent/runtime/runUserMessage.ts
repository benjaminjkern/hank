// Top-level chat entry point — the function /api/chat/route.ts invokes per user
// message. See docs/runtime.md for the architectural overview.
//
// It owns THE RUN and nothing else: everything here is true of any message
// regardless of what the message says.
//   1. Concurrency guard via claimSessionForNewRun — if a LIVE prior run is in
//      flight, yield ALREADY_STREAMING and bail before persisting anything (a
//      stale/aborted-but-wedged run is reclaimed instead of blocking).
//   2. An AbortController the Stop endpoint can find, and a runId every row the
//      run produces is stamped with.
//   3. Hand the whole message to `runChat` — the chat procedure — through
//      `recordTranscript`, which persists every content event the run streams.
//   4. Classify how the run ENDED: a user Stop is a clean end, a missing key is
//      the modal's to fix, and anything else is a failure that gets a
//      transcript row of its own.
//
// The key gate is a CATCH, not a pre-flight, and it has to stay one: `runChat`
// opens by writing the user's message, so bailing before it runs would drop
// what they typed on the floor of the very failure the modal asks them to fix.
// Every path to a missing key throws one of two error types, so catching them
// here needs no probe of its own.
//
// What the message MEANS is deliberately not here. Which widget submission
// commits, when the walkthrough state machine drives, whether the profile is
// thin enough to elicit against, what it means that a company ended — all of it
// lives in procedures/registry/chat/, because all of it is a product decision.
// This layer must stay able to run a turn without knowing what a company is.
//
// Aborts (user-pressed Stop) propagate via runController.signal all the way down
// through the procedure → sub-agents.

import type { LoopEvent } from "@/server/agent/contracts";
import {
  clearActiveRun,
  claimSessionForNewRun,
  registerActiveRun,
} from "@/server/agent/runtime/stopRegistry";
import { newRunTreeId } from "@/server/agent/runTree/ids";
import {
  appendRunError,
  getOrCreateActiveSession,
  recordTranscript,
} from "@/server/agent/session";
import { classifyLlmError } from "@/server/platform/llm/classifyLlmError";
import {
  NoAnthropicKeyError,
  NoDeepseekKeyError,
} from "@/server/platform/llm/resolveClient";
// The one sanctioned runtime→domain edge: runUserMessage opens THE RUN and
// hands the message to runChat. This import IS the handoff — see AGENTS.md
// "runtime/ is the one part of agent/ that may not know what a company is".
// eslint-disable-next-line boundaries/dependencies -- documented handoff exception
import { runChat } from "@/server/procedures/registry/chat";
import { isUserAbortError } from "@/utils/abort";
import { nowMs } from "@/utils/now";

type RunUserMessageArgs = {
  userId: string;
  userMessage: string;
  attachmentIds?: string[];
  signal?: AbortSignal;
  // The browser's IANA timezone (e.g. "America/Los_Angeles"), sent per message.
  // Flows to the # Today block and the event tools so logged times land at the
  // right instant rather than midnight UTC. Undefined (old clients / replay)
  // falls back to UTC everywhere it's read.
  timeZone?: string;
  // Test-only override. Production callers (chat route, API endpoints) omit
  // this and the function uses getOrCreateActiveSession(userId). Scenarios
  // set TEST_SESSION_ID here so runUserMessage exercises the cold-start /
  // dispatcher branches without mutating the user's real chat session.
  sessionIdOverride?: string;
};

// A prior run older than this (and not already aborted) is treated as stale and
// reclaimed by claimSessionForNewRun so it can't lock the session. Matches the
// chat route's MAX_RUN_MS cap — the cap aborts at this age anyway, so the
// aborted-controller check normally fires first; this is the belt-and-suspenders
// bound for the rare case the cap timer didn't run.
const RUN_MAX_AGE_MS = 5 * 60_000;

export async function* runUserMessage(
  args: RunUserMessageArgs,
): AsyncGenerator<LoopEvent> {
  // 1. Get/create the active session. Scenarios can pass `sessionIdOverride` to
  // target the test session instead.
  const sessionId =
    args.sessionIdOverride ?? (await getOrCreateActiveSession(args.userId)).id;

  // Refuse a second runUserMessage on the same ChatSession while one is GENUINELY
  // in flight. The UI's canSend gate prevents this in normal use, but a two-tab
  // race or a torn SSE that left the previous run still writing tool result rows
  // would otherwise interleave writes and leave the conversation unreplayable.
  // But a run that already aborted (Stop / the route's MAX_RUN_MS cap fired) yet
  // never unwound — wedged on a hung await so its finally never cleared the
  // registry — must NOT lock the user out until a process restart. That was the
  // "couldn't chat, only a refresh fixed it" trap. claimSessionForNewRun
  // reclaims such a stale run and lets this message through; it refuses only a
  // live one. Reject before persisting anything; the client maps ALREADY_STREAMING
  // to a transient notice that restores the user's typed text into the composer.
  if (!claimSessionForNewRun(sessionId, RUN_MAX_AGE_MS)) {
    yield {
      type: "error",
      code: "ALREADY_STREAMING",
      message:
        "Hank is still working on the previous message. Wait for it to finish, then resend.",
    };
    return;
  }

  // Register this run so /api/chat/stop can locate the AbortController and
  // so re-entry attempts hit the guard above. Always cleared in finally.
  const runController = new AbortController();
  if (args.signal) {
    if (args.signal.aborted) runController.abort();
    else {
      args.signal.addEventListener("abort", () => runController.abort(), {
        once: true,
      });
    }
  }
  registerActiveRun(sessionId, args.userId, runController);

  // Run-tree capture (admin /admin/runs): one id for this whole runUserMessage
  // call. Stamped on every ChatMessage / TokenUsage / SubAgentRun row it (and
  // everything it drives) produces so the inspector groups the run.
  const runId = newRunTreeId();

  try {
    // recordTranscript is the ONE writer of streamed chat content — wrapping the
    // whole procedure here is what makes "anything the user saw has a row" true
    // of every path rather than of whichever emitters remembered to persist.
    const stream = recordTranscript(
      runChat({
        userId: args.userId,
        sessionId,
        userMessage: args.userMessage,
        attachmentIds: args.attachmentIds ?? [],
        timeZone: args.timeZone,
        signal: runController.signal,
        runId,
        // The route's cap and the stale-run reclaim share the same age bound,
        // so this is when the cap will abort the run. Long fan-outs read it to
        // stand down cleanly first.
        deadlineAt: nowMs() + RUN_MAX_AGE_MS,
      }),
      { sessionId, runId },
    );
    for await (const ev of stream) {
      // The procedure's `done` carries the turn's outcome, which it has already
      // acted on by the time it surfaces here. The client only needs the one
      // terminal below.
      if (ev.type !== "done") yield ev;
    }
    yield { type: "done" };
  } catch (err) {
    // A user Stop that reaches HERE came from the deterministic layer, which
    // re-throws it rather than degrading it: runSubAgent does, and so does
    // scrapeUrl (returning a failed scrape instead would read as "this board is
    // unreadable" and set the company BLOCKED). A Stop inside a Hank turn never
    // arrives — runAgentTurn already turns it into `stopped`. Either way it's a
    // clean end, and letting it out of the run would surface the abort as a
    // chat error banner instead of the stopped pill.
    if (isUserAbortError(err)) {
      yield { type: "stopped" };
      yield { type: "done" };
    } else if (
      err instanceof NoAnthropicKeyError ||
      err instanceof NoDeepseekKeyError
    ) {
      // No usable key for HANK_MODEL — today NoDeepseekKeyError (→
      // NO_DEEPSEEK_KEY); the Anthropic arm covers HANK_MODEL ever moving to
      // Claude. The blocking modal is the fix path, so this gets no transcript
      // row (same reason the classified key/credit faults below don't) — but
      // the user's message is already persisted, so it's waiting for them once
      // they've pasted a key.
      yield { type: "error", code: err.code, message: err.message };
      yield { type: "done" };
    } else {
      // A genuine failure. Record it in the transcript BEFORE re-throwing: the
      // route turns the throw into an SSE `error` + `done`, and that `done` makes
      // the client reconcile from the DB — which would replace away an error that
      // only ever existed in client memory (it flashed, then vanished). The row is
      // what makes it stick, and what lets the user expand it after the fact.
      // Key/credit failures are excluded because the blocking modal is their fix
      // path; a chat row would double up on it.
      //
      // Best-effort, and the swallow is load-bearing: the class of failure this
      // records includes the DB itself being unreachable, so letting the write's
      // own throw escape would replace the real error with a worse one.
      if (!classifyLlmError(err)) {
        try {
          await appendRunError(
            sessionId,
            err instanceof Error ? err.message : String(err),
            { runId },
          );
        } catch {
          // Nothing left to do — the SSE error below is the only surface.
        }
      }
      throw err;
    }
  } finally {
    clearActiveRun(sessionId);
  }
}
