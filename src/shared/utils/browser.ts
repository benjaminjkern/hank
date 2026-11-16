// True when the page is running as an installed PWA rather than a browser tab.
// iOS gates Web Push on this (Notification.requestPermission() only resolves
// inside a home-screen PWA, Safari ≥16.4), and Safari reports it via the
// non-standard navigator.standalone rather than the display-mode media query.
// SSR-safe: false when there is no window.
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone);
}
