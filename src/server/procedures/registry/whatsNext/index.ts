// The deterministic "what's next?" rung walk, and the `show_whats_next` entry
// that renders it. The walk has two outcomes:
//
//   1. Rung 0 fails → profile enrichment is still required. Reported to the
//      caller (no widget, NO state mutation) along with the gaps, which it
//      threads into the runner so Hank opens on the specifics.
//   2. Rung 0 passes → the options payload for the next-company picker widget.
//
// A procedure rather than a read model because rung 0 costs an LLM call — the
// gate is `runProfileEnrichmentGate`. The section loads underneath it are pure
// and live in procedures/registry/whatsNext/options.ts, which is why `show_whats_next` can
// render the picker mid-flow by calling `computeWhatsNextOptions` directly: it's
// only offered where the profile is already past the gate, and the gate stays a
// cold-start / between-flow concern owned by this procedure.

import { sayUiEvents, statusEvent, widgetEvent } from "@/server/contracts";
import type { StepArgs, StepOutcome } from "@/server/contracts";
import { buildShowEvents } from "@/server/panels/showEvents";
import type { RunContext } from "@/server/platform/runContext";
import { traceText } from "@/server/platform/runs/traceText";
import { procedure } from "@/server/procedures/lib/procedure";
import { runProfileEnrichmentGate } from "@/server/procedures/registry/profileEnrichmentGate";
import {
  computeWhatsNextOptions,
  type NextOptionSections,
} from "@/server/procedures/registry/whatsNext/options";

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

// The walk itself — what the chooser WOULD show. runShowWhatsNext renders it.
export const runWhatsNext = procedure(
  "whats_next",
  async (args: WhatsNextArgs): Promise<WhatsNextResult> => {
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
  },
);

function breadcrumb(args: WhatsNextArgs, note: string): void {
  console.info(`[whatsNext] ${note}`);
  traceText(args.trace, `whatsNext: ${note}`);
}

// Hank's opening when the chooser can't render because the profile is still too
// thin to match against: there's no user row for him to answer.
const PROFILE_INTAKE_NUDGE = "(Starting profile setup — greet me and begin.)";

// The `show_whats_next` entry. Puts the chooser up and waits — or, when the
// profile gate is still open, hands to Hank with what's missing so he asks for
// it. `afterOtherWork` = something already ran this message, so the switch into
// profile questions gets a one-line cue instead of arriving unannounced.
export const runShowWhatsNext = procedure(
  "show_whats_next",
  async (
    args: StepArgs & { afterOtherWork: boolean },
  ): Promise<StepOutcome> => {
    const result = await runWhatsNext(args);
    if (result.kind === "profile") {
      if (args.afterOtherWork) {
        await args.say(
          statusEvent(
            "One sec — grabbing a couple quick details so I can match you well.",
          ),
        );
      }
      await sayUiEvents(args.say, (await buildShowEvents(args.userId)).events);
      return {
        next: {
          kind: "hank",
          nudge: PROFILE_INTAKE_NUDGE,
          profileGaps: {
            missing: result.missing,
            suggestedProbes: result.suggestedProbes,
          },
        },
      };
    }
    await args.say(
      widgetEvent("next_company_picker", {
        immediate: result.options.immediate,
        deferred: result.options.deferred,
        backlog: result.options.backlog,
        empty: result.empty,
      }),
    );
    return {};
  },
);
