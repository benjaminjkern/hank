// The discovery list's payload — the companies the last search proposed, as
// the panel's discovery screen draws them. Built by loadDiscoveryList
// (server/views/discoveryList.ts).

import type {
  NegotiationRow,
  NegotiationState,
} from "@/shared/views/negotiationPanel";

export type DiscoveryRow = NegotiationRow & {
  id: string;
  name: string;
  reason: string;
  // What the search established about the company. Null on a row Hank added
  // himself and on rows written before the search returned one.
  summary: string | null;
  url: string | null;
  // False means the mark in force is "pass" — the user unchecked it, or Hank
  // did on their say-so.
  checked: boolean;
};

// `openThreadCount` is always 0: a candidate is a name and a reason, so there is
// nothing here Hank can ask about that unchecking doesn't already answer.
export type DiscoveryListView = NegotiationState & {
  rows: DiscoveryRow[];
};
