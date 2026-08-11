// The panel-sync contract: what a tool (or buildShowEvents) tells the client to
// put on screen. Lives in agent/contracts/ rather than agent/tools/lib/ because
// the deterministic layer emits these too — views/showEvents.ts and the
// widget dispatchers produce UiEvents without being tools.

import type { PanelMode } from "@/lib/panelMode";
import type { ApplicationView } from "@/server/views/application";
import type { DiscoveryListView } from "@/server/views/discoveryList";
import type { FocusedCompanyView } from "@/server/views/getFocusedCompany";
import type { FocusedJobView } from "@/server/views/getFocusedJob";
import type { FocusedOpportunityView } from "@/server/views/getFocusedOpportunity";
import type { ShortlistBoardView } from "@/server/views/shortlistBoard";

export type UiEvent =
  // Presentational "put this entity on the user's screen" event — the show_*
  // tools' (and pipeline dispatch's) panel switch. Focus is ephemeral, so there
  // is no sticky-focus id to carry: the client updates only `viewed*` +
  // `panelMode`. Showing an entity is a view change, not a focus change.
  | {
      type: "show";
      company: FocusedCompanyView | null;
      job: FocusedJobView | null;
      opportunity: FocusedOpportunityView | null;
      board: ShortlistBoardView | null;
      application: ApplicationView | null;
      discovery: DiscoveryListView | null;
    }
  // Documents / analytics are excluded because nothing server-side can put
  // them on screen — they carry no entity, so no show event resolves to one.
  | {
      type: "panel_mode";
      mode: Exclude<PanelMode, "documents" | "analytics">;
    };
