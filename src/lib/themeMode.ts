"use client";

import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "hank-theme";

interface Snapshot {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

const SERVER_SNAPSHOT: Snapshot = { mode: "system", resolved: "dark" };

let snapshot: Snapshot = SERVER_SNAPSHOT;
const subscribers = new Set<() => void>();
let initialized = false;
let mql: MediaQueryList | null = null;

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {}
  return "system";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return mql && mql.matches ? "dark" : "light";
}

function apply(resolved: ResolvedTheme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
  }
}

function emit() {
  subscribers.forEach((fn) => fn());
}

function ensureInit() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  mql = window.matchMedia("(prefers-color-scheme: dark)");
  const mode = readStoredMode();
  const resolved = resolve(mode);
  snapshot = { mode, resolved };
  apply(resolved);
  mql.addEventListener("change", () => {
    if (snapshot.mode !== "system") return;
    const next = resolve("system");
    if (next === snapshot.resolved) return;
    snapshot = { mode: "system", resolved: next };
    apply(next);
    emit();
  });
}

function subscribe(fn: () => void): () => void {
  ensureInit();
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function getSnapshot(): Snapshot {
  ensureInit();
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

function setThemeMode(mode: ThemeMode) {
  ensureInit();
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  const resolved = resolve(mode);
  snapshot = { mode, resolved };
  apply(resolved);
  emit();
}

export function useThemeMode(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
} {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { mode: s.mode, resolved: s.resolved, setMode: setThemeMode };
}
