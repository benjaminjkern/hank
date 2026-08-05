// Reconstruct the one-line right-panel hint a user would perceive after a
// turn (e.g. "(Right panel: Ramp's company page is open)"). We don't render
// the full panel — the maintainer's call — just signal WHICH entity pulled up so the
// persona can react to a focus change ("good, the company I asked about
// showed up").
//
// Focus is ephemeral — there's no slot to read. The panel is driven by the
// `show` events a turn emits, so the driver captures the LAST one and hands it
// here; null (no show event this turn) means the panel didn't move (default:
// the dashboard).

import type { UiEvent } from "@/server/agent/contracts";

type ShowEvent = Extract<UiEvent, { type: "show" }>;

export function resolvePanelHint(lastShow: ShowEvent | null): string {
  if (lastShow?.job) {
    return `(Right panel: the role "${lastShow.job.title}" is open)`;
  }
  if (lastShow?.opportunity) {
    return `(Right panel: the lead "${lastShow.opportunity.label}" is open)`;
  }
  if (lastShow?.company) {
    return `(Right panel: ${lastShow.company.name}'s company page is open)`;
  }
  return `(Right panel: your dashboard of watched companies)`;
}
