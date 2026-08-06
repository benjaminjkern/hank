"use client";

import { useEffect } from "react";

import { useChatStore } from "@/lib/chatStore";
import { panelUrl } from "@/lib/panelUrl";

// The one place panel state and the URL are kept in agreement, in both
// directions. Every navigator in the app — breadcrumbs, dashboard rows, chat
// chips, the TopBar, Hank's show events — goes through a chatStore action, so
// subscribing to the store covers all of them at once and the URL can't drift
// from what's on screen.
//
// Next 16 integrates native pushState/replaceState with its router: the URL and
// usePathname update, no RSC request is made, and Back/Forward restores the
// already-rendered tree. So the shell's server component runs once per document
// load and this listener owns everything after it.
export function PanelUrlSync() {
  useEffect(() => {
    // The admin view-session shell mounts the same panel under its own route.
    // Its mount site omits this component, but leaving the store's identity is
    // a store RESET — a writer still mounted through that transition would push
    // the reset (dashboard) state over the admin URL.
    if (useChatStore.getState().impersonateSessionId) return;

    const unsubscribe = useChatStore.subscribe((state) => {
      const next = panelUrl(state);
      // No address for this state (an entity mode whose payload hasn't landed
      // yet — the SSE pair sets payloads and mode in separate updates). Leave
      // the URL alone rather than flickering it to the dashboard.
      if (next === null) return;
      if (next === window.location.pathname) return;
      // Preserve any query string: pushing a bare pathname would drop it.
      const url = next + window.location.search;
      if (state.panelMovedBy === "user")
        window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    });

    const onPopState = () => {
      void useChatStore.getState().viewPanelPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return null;
}
