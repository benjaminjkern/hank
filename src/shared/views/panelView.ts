// The whole right panel, as a URL loads it — the shell's first paint and the
// popstate refetch. Built by loadPanelView (server/views/panelView.ts).

import type { DocumentsSubPage, PanelMode } from "@/shared/panelMode";
import type { ApplicationView } from "@/shared/views/application";
import type { DiscoveryListView } from "@/shared/views/discoveryList";
import type { FocusedCompanyView } from "@/shared/views/getFocusedCompany";
import type { FocusedJobView } from "@/shared/views/getFocusedJob";
import type { FocusedOpportunityView } from "@/shared/views/getFocusedOpportunity";
import type { ShortlistBoardView } from "@/shared/views/shortlistBoard";

export type PanelView = {
  panelMode: PanelMode;
  company: FocusedCompanyView | null;
  job: FocusedJobView | null;
  opportunity: FocusedOpportunityView | null;
  board: ShortlistBoardView | null;
  application: ApplicationView | null;
  discovery: DiscoveryListView | null;
  documentsSubPage: DocumentsSubPage;
  // Whether this address wants the panel showing. Only the dashboard has both
  // answers (`/` stows it, `/dashboard` opens it); naming any other view IS
  // asking to see it, so they're all true.
  panelOpen: boolean;
};
