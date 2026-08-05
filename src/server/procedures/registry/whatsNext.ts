// The deterministic "what's next?" rung walk. Two outcomes:
//
//   1. Rung 0 fails → profile enrichment is still required. Reported to the
//      caller (no widget, NO state mutation) along with the gaps, which it
//      threads into the runner so Hank opens on the specifics.
//   2. Rung 0 passes → the options payload for the next-company picker widget.
//
// A procedure rather than a read model because rung 0 costs an LLM call — the
// gate is `runProfileEnrichmentGate`. The section loads underneath it are pure
// and live in views/whatsNextOptions.ts, which is why `show_whats_next` can
// render the picker mid-flow by calling `computeWhatsNextOptions` directly: it's
// only offered where the profile is already past the gate, and the gate stays a
// cold-start / between-flow concern owned by this procedure.

import type { RunContext } from "@/server/agent/contracts";
import { traceText } from "@/server/platform/trace/traceText";
import { runProfileEnrichmentGate } from "@/server/procedures/registry/profileEnrichmentGate";
import {
  computeWhatsNextOptions,
  type NextOptionSections,
} from "@/server/views/whatsNextOptions";

type WhatsNextResult =
  // Rung 0 failed — profile setup is a precondition. Caller forces the profile
  // intake and skips the widget entirely. `missing` / `suggestedProbes` are
  // the gatekeeper's read of what's thin — relayed to the enrich-profile agent
  // so it opens on the specific gaps (empty arrays if the sub-agent failed).
  | { kind: "profile"; missing: string[]; suggestedProbes: string[] }
  // Rung 0 passed — render the next-company picker. `empty` is true when
  // there's literally nothing to pick (no immediate, deferred, or backlog) —
  // caller renders the empty-state variant ("Add companies…" CTA).
  | { kind: "pick"; options: NextOptionSections; empty: boolean };

// `sessionId` is required here even though RunContext leaves it optional — the
// rung-0 gate is a chat-session concern and there's no cold path into this.
type WhatsNextArgs = RunContext & { sessionId: string };

// Single entry point. Caller (renderWhatsNext) inspects the result kind:
//   - "profile": emit the brief transition status, then Hank runs profile intake.
//   - "pick": render the next_company_picker widget with the options payload.
//     If options.empty is true, the widget renders only the "Add companies"
//     CTA (no sections).
export async function runWhatsNext(
  args: WhatsNextArgs,
): Promise<WhatsNextResult> {
  // The full verdict, not just a boolean: the gatekeeper's `missing` /
  // `suggestedProbes` are what the enrich-profile agent opens with instead of
  // starting cold.
  const verdict = await runProfileEnrichmentGate(args);
  if (!verdict.enriched) {
    breadcrumb(args, "rung=0 result=profile reason=enrichment_gate_open");
    return {
      kind: "profile",
      missing: verdict.missing,
      suggestedProbes: verdict.suggestedProbes,
    };
  }

  const { options, empty } = await computeWhatsNextOptions(args.userId);
  breadcrumb(
    args,
    `rung=pick immediate=${options.immediate.length} deferred=${options.deferred.length} backlog=${options.backlog.length} empty=${empty}`,
  );
  return { kind: "pick", options, empty };
}

function breadcrumb(args: WhatsNextArgs, note: string): void {
  console.info(`[whatsNext] ${note}`);
  traceText(args.trace, `whatsNext: ${note}`);
}
