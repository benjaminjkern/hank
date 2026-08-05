import { useState } from "react";

// Shared "preview N, then expand" logic for the right-panel lists that cap
// their visible length behind a show-more toggle: the dashboard company /
// opportunity job lists, the company-page job groups, the recent-activity
// timeline, and the application-questions panel. Each of those surfaces had
// its own copy of the same slice + truncation + toggle bookkeeping, which is
// where the off-by-one "+N more" / "Collapse" bugs kept getting re-derived.
//
// The hook owns only the *logic*; each caller keeps its own markup and copy
// (the dashboard says "+N more", the company page says "Show N more") — the
// variation that's intentional stays local, the bookkeeping that should never
// differ is shared.
//
// previewCount is the cap. Pass `items.length` to opt out of capping (e.g. a
// group that only shows a toggle in some configurations) — canCollapse is then
// false and the full list always renders.
export function useExpandable<T>(items: T[], previewCount: number) {
  const [expanded, setExpanded] = useState(false);
  // Long enough to be worth capping — drives whether any toggle renders.
  const canCollapse = items.length > previewCount;
  // Currently showing the capped slice (collapsed + cappable).
  const truncated = !expanded && canCollapse;
  const visible = truncated ? items.slice(0, previewCount) : items;
  // How many rows sit behind "+N more" while collapsed. Callers whose list is
  // a server-capped slice (recent activity) compute their own count from the
  // authoritative total instead — this assumes `items` is the full list.
  const hiddenCount = Math.max(0, items.length - previewCount);

  return {
    visible,
    expanded,
    truncated,
    canCollapse,
    hiddenCount,
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    toggle: () => setExpanded((v) => !v),
  };
}
