"use client";

import { useEffect } from "react";

import { useChatStore, type ApiKeyBlockerReason } from "@/lib/chatStore";
import type { PanelView } from "@/server/views/panelView";

// Module scope = once per document load, which is exactly the lifetime the
// server-rendered seed is valid for. A real navigation re-imports the module.
let panelSeeded = false;

export function ChatHydrator({
  initialApiKeyBlocker,
  initialPanel,
  impersonateSessionId,
}: {
  initialApiKeyBlocker: ApiKeyBlockerReason | null;
  // The panel the URL names, loaded server-side. Absent on the impersonation
  // shell, which has no addressable panel state of its own.
  initialPanel?: PanelView;
  // Present only on /admin/session/[sessionId]. Once seeded, every read fetch
  // in chatStore carries `?impersonate={id}` so the server returns the
  // target session's owner's data instead of the caller's.
  impersonateSessionId?: string;
}) {
  const hydrate = useChatStore((s) => s.hydrate);
  const setApiKeyBlocker = useChatStore((s) => s.setApiKeyBlocker);
  const showPanelView = useChatStore((s) => s.showPanelView);
  const setImpersonateSessionId = useChatStore(
    (s) => s.setImpersonateSessionId,
  );
  useEffect(() => {
    // Identity first: it RESETS the store when it changes, which would wipe a
    // blocker seeded before it. Called unconditionally, including the `null`
    // the app root passes — this is what tells the store which identity the
    // mounting page wants, and both directions are client-side navigations
    // that leave the previous identity's data in place. No-op when unchanged.
    setImpersonateSessionId(impersonateSessionId ?? null);
    // Seed before hydrate so the modal renders on the first paint when no
    // key is on file — waiting for /api/session would let the chat surface
    // flash in unblocked for a tick.
    if (initialApiKeyBlocker) setApiKeyBlocker(initialApiKeyBlocker);
    // Same reason: the panel this URL names is already loaded, so paint it
    // rather than flashing the dashboard until /api/session lands.
    //
    // ONCE per document, though. Next restores a Back press from its rendered
    // tree rather than re-running the server component, and the client pushes
    // panel URLs natively — so the tree behind `/dashboard/stripe` can be the
    // one rendered for `/`, carrying ITS `initialPanel`. Re-seeding from that
    // on remount reset the panel to the dashboard and the URL writer then
    // followed it to `/`, which is the "Back loaded the right page then
    // redirected" bug. After the first paint the URL is the authority, and
    // PanelUrlSync reconciles to it.
    if (initialPanel && !panelSeeded) {
      panelSeeded = true;
      showPanelView(initialPanel);
    }
    void hydrate();
  }, [
    hydrate,
    setApiKeyBlocker,
    showPanelView,
    setImpersonateSessionId,
    initialApiKeyBlocker,
    initialPanel,
    impersonateSessionId,
  ]);

  // Reconcile-on-return. A turn's SSE stream can be missed entirely when the
  // tab is backgrounded or a mobile PWA is suspended — the OS tears down the
  // socket, the server aborts + persists its partial/complete progress, and
  // the client never sees the terminal `done` (so it can't reconcile). The DB
  // is the source of truth, so when the user comes back, pull the real state:
  //   - visibilitychange → visible: desktop tab + Android PWA foreground.
  //   - pageshow: bfcache restore (iOS Safari/PWA back-forward / resume).
  //   - online: network recovered independent of visibility.
  // `reconcileFromServer` self-guards against firing during an active stream
  // (a live connected turn reconciles itself on `done`), so this only repairs
  // turns whose stream the client actually missed. Debounced so the three
  // events firing together on one return collapse into a single /api/session
  // hit. Mounted here at the stable app root (not ChatPanel, which remounts on
  // the narrow-viewport pane swap).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const s = useChatStore.getState();
        if (!s.hydrated) return; // initial load already pulls via hydrate()
        s.reconcileFromServer();
      }, 400);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("online", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("online", schedule);
    };
  }, []);

  return null;
}
