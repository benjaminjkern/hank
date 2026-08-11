// Per-turn context for an open discovery list: the companies on the user's
// screen and how they've marked them, so Hank negotiates over the list without
// re-reading anything and knows when `commit_discovery` is the right call.
//
// Shaped by the prompt rather than the panel — same reason
// shortlistBoardContext lives here and not in views/.

import {
  loadDiscoveryList,
  renderDiscoveryListText,
} from "@/server/views/discoveryList";

export async function loadHankDiscoveryContext(
  userId: string,
): Promise<string | undefined> {
  const view = await loadDiscoveryList(userId);
  if (view.rows.length === 0) return undefined;
  return renderDiscoveryListText(view) || undefined;
}
