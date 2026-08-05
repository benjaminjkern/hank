import { z } from "zod";

import { runUserMessage } from "@/server/agent/runtime/runUserMessage";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";
import { classifyLlmError } from "@/server/platform/llm/classifyLlmError";

// No message-or-attachments guard: a send with an empty composer is a real
// action when the user's shortlist-board marks are the message. What makes it a
// turn is server-derived (runChat looks for unrelayed marks), so the client
// can't assert it here — and an empty send with nothing pending simply falls
// through to the what's-next picker.
const Body = z.object({
  message: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  // The browser's IANA timezone (Intl…resolvedOptions().timeZone). Optional so
  // an old client / non-browser caller still works (falls back to UTC).
  clientTimeZone: z.string().optional(),
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response("invalid body", { status: 400 });
  }

  // Disconnect ≠ Stop (chat-round4). A client disconnect — backgrounded tab,
  // network blip, navigation away — must NOT kill in-flight work: a long
  // revive/scan finishes server-side and persists, so the user finds the result
  // on return (the "connection dropped → it removed what it was working on"
  // bug). So we deliberately do NOT forward req.signal to runController. The
  // user's Stop button aborts intentionally through POST /api/chat/stop (the
  // registry controller, which runUserMessage threads into its signal).
  // req.signal only flags the client as gone so we stop enqueueing while still
  // DRAINING runUserMessage to completion. A hard cap bounds any runaway so a
  // gone-client run can't spin indefinitely (the maintainer: spending tokens on a gone
  // client is fine, an unbounded run is not).
  const runController = new AbortController();
  const MAX_RUN_MS = 5 * 60_000;
  let clientGone = req.signal.aborted;
  req.signal.addEventListener(
    "abort",
    () => {
      clientGone = true;
    },
    { once: true },
  );

  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 15_000;
  const stream = new ReadableStream({
    async start(controller) {
      // Enqueue, but never throw on a closed stream — once the client is gone
      // we keep consuming runUserMessage (so its work finishes + persists) and
      // simply stop writing.
      const safeEnqueue = (s: string): void => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          clientGone = true;
        }
      };
      // Heartbeat so the connection doesn't idle out during long SILENT server
      // phases — reading dozens of postings in full is many sequential LLM
      // calls with no SSE event, and those gaps were dropping the connection
      // (then the work + its widget vanished). SSE comment line; the client's
      // `data:` parser ignores it.
      const heartbeat = setInterval(
        () => safeEnqueue(`: keepalive\n\n`),
        KEEPALIVE_MS,
      );
      // Single close path — clears the heartbeat and closes the stream once.
      let closed = false;
      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      // Hard cap. The keepalive above is a double-edged sword: it also keeps the
      // client's no-bytes watchdog from ever firing, so if runUserMessage WEDGES
      // (a hung DB call, a loop that never checks the abort signal) it never
      // yields another event, never returns, the finally never runs — and the
      // client would spin in `streaming` forever with a dead Stop button. So the
      // cap must FORCE a terminal to the client, not merely abort the run: emit
      // error+done and close the stream so the client reconciles from the DB.
      // (We still abort the run so it stops spending; if it ignores the abort,
      // claimSessionForNewRun reclaims it on the user's next message.)
      const cap = setTimeout(() => {
        runController.abort();
        safeEnqueue(
          `data: ${JSON.stringify({ type: "error", message: "This response timed out." })}\n\n`,
        );
        safeEnqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        closeStream();
      }, MAX_RUN_MS);
      try {
        for await (const event of runUserMessage({
          userId: user.id,
          userMessage: parsed.data.message,
          attachmentIds: parsed.data.attachmentIds,
          timeZone: parsed.data.clientTimeZone,
          signal: runController.signal,
        })) {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        const classified = classifyLlmError(err);
        const payload = classified
          ? {
              type: "error",
              code: classified.code,
              message: classified.message,
            }
          : {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            };
        safeEnqueue(`data: ${JSON.stringify(payload)}\n\n`);
        // Follow the error with a terminal `done` so a still-connected client
        // reconciles against the DB (pipelines persist each turn's progress +
        // flush partials on throw, so the server usually wrote more than the
        // live stream showed). Harmless for the key-modal error codes.
        // That reconcile is also why the failure itself has to be a transcript
        // row rather than only this event: runUserMessage writes a `run_error`
        // block before re-throwing, so the expandable error the client paints
        // from this event survives the refetch instead of being replaced away.
        safeEnqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } finally {
        clearTimeout(cap);
        closeStream();
      }
    },
    cancel() {
      // Consumer cancelled (navigated away / aborted the fetch). Stop
      // enqueueing, but do NOT abort runController — the run finishes
      // server-side (bounded by the cap above). An intentional Stop aborts via
      // /api/chat/stop, not via this cancel.
      clientGone = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
