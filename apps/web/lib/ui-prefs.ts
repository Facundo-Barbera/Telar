"use client";

// Client-only UI preferences — appearance (theme), agent defaults for NEW
// sessions, and notification toggles. Persisted to localStorage under the
// "telar-ui-prefs" key.
//
// CLIENT-BUNDLE RULE: this module imports NOTHING that reaches the Agent SDK or
// any server-only code (models.ts is import-free data; permission-modes.ts is
// client-safe constants). It is a plain external store — subscribe + snapshot,
// read via useSyncExternalStore — persisted to localStorage. There is no zustand
// dependency in this app, so we follow the same context/localStorage convention
// the dock + sidebar use (see dock-provider.tsx, app-sidebar's useStoredList).
//
// LOOM DOCTRINE: everything here is a UI PREFERENCE only. Nothing writes
// telar.yaml / .telar or any engine env. The "agent defaults" are merely the
// INITIAL composer value for a brand-new session in a project with no remembered
// config — per-project memory and per-session choices always win over them.

import { useSyncExternalStore } from "react";
import { DEFAULT_MODEL } from "./models";
import { DEFAULT_RUNTIME_MODE, runtimeModeFromLegacy, type RuntimeMode } from "./permission-modes";
import type { ProviderSort } from "./provider-order";
import { isProviderSort } from "./provider-order";

const KEY = "telar-ui-prefs";

export type ThemeMode = "system" | "light" | "dark";

export type UiPrefs = {
  theme: ThemeMode;
  // Initial composer values for NEW sessions only — a fallback, not an override.
  defaultModel: string;
  // In the ONE vocabulary both harnesses share. It used to be Claude's
  // `defaultPermissionMode`, which was the last copy of the old three-word set
  // and meant this pane and the composer showed different words for the same
  // three rungs. Old payloads are read forward by sanitize() below.
  defaultRuntimeMode: RuntimeMode;
  notifications: {
    enabled: boolean; // master toggle
    loomParked: boolean; // a loom parked and needs you
    loomReady: boolean; // a loom is ready to accept
  };
  // Seconds between automatic provider re-checks while the Providers settings
  // page is open. 0 = manual only. Detection spawns a subprocess per provider,
  // so this is deliberately a visible cost the user sets, not a hidden poll —
  // and it takes effect exactly where it says it does, nowhere else.
  providerCheckIntervalSec: number;
  // How the Providers list is ordered, and whether switched-off accounts sink
  // below the rest. Both are VIEW state, not registry state: they change what
  // this browser shows and nothing about the accounts themselves, which is why
  // they live here in localStorage rather than in accounts.json.
  providerSort: ProviderSort;
  providerDisabledLast: boolean;
};

// Production has always shipped dark; keep it the default so nothing flashes for
// existing users. Notifications default OFF (opt-in, needs a permission grant).
export const DEFAULT_PREFS: UiPrefs = {
  theme: "dark",
  defaultModel: DEFAULT_MODEL,
  defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
  notifications: { enabled: false, loomParked: true, loomReady: true },
  providerCheckIntervalSec: 300,
  // Grouped by provider is the order this list has always had, so it stays the
  // default. Sinking the disabled rows is new and ON by default — an account
  // you switched off is one you told Telar not to use, and it should stop
  // competing with the ones you did.
  providerSort: "provider",
  providerDisabledLast: true,
};

const THEMES: ThemeMode[] = ["system", "light", "dark"];

// Merge persisted JSON over the defaults, dropping anything malformed — old or
// partial payloads must always load as a complete, valid UiPrefs.
function sanitize(raw: unknown): UiPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
  const r = raw as Record<string, unknown>;
  const n = (r.notifications ?? {}) as Record<string, unknown>;
  return {
    theme: THEMES.includes(r.theme as ThemeMode) ? (r.theme as ThemeMode) : DEFAULT_PREFS.theme,
    providerCheckIntervalSec:
      typeof r.providerCheckIntervalSec === "number" &&
      Number.isFinite(r.providerCheckIntervalSec) &&
      r.providerCheckIntervalSec >= 0
        ? Math.floor(r.providerCheckIntervalSec)
        : DEFAULT_PREFS.providerCheckIntervalSec,
    providerSort: isProviderSort(r.providerSort) ? r.providerSort : DEFAULT_PREFS.providerSort,
    providerDisabledLast:
      typeof r.providerDisabledLast === "boolean"
        ? r.providerDisabledLast
        : DEFAULT_PREFS.providerDisabledLast,
    defaultModel:
      typeof r.defaultModel === "string" && r.defaultModel ? r.defaultModel : DEFAULT_PREFS.defaultModel,
    // New spelling first, then the old one through the same legacy table the
    // route and the Chat store use, then the default — so a browser that has
    // been carrying "acceptEdits" since before the rename keeps the preference
    // it set rather than silently reverting.
    defaultRuntimeMode:
      runtimeModeFromLegacy({
        runtimeMode: r.defaultRuntimeMode,
        permissionMode: r.defaultPermissionMode,
      }) ?? DEFAULT_PREFS.defaultRuntimeMode,
    notifications: {
      enabled: typeof n.enabled === "boolean" ? n.enabled : DEFAULT_PREFS.notifications.enabled,
      loomParked:
        typeof n.loomParked === "boolean" ? n.loomParked : DEFAULT_PREFS.notifications.loomParked,
      loomReady: typeof n.loomReady === "boolean" ? n.loomReady : DEFAULT_PREFS.notifications.loomReady,
    },
  };
}

function load(): UiPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: UiPrefs = DEFAULT_PREFS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Hydrate lazily on first client read so SSR (which returns DEFAULT_PREFS via
// getServerSnapshot) and the first client snapshot agree, then useSyncExternalStore
// re-renders with the real value — no hydration mismatch.
function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  current = load();
}

export function getUiPrefs(): UiPrefs {
  ensureHydrated();
  return current;
}

export function setUiPrefs(patch: Partial<UiPrefs> | ((p: UiPrefs) => UiPrefs)) {
  ensureHydrated();
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / storage blocked — prefs just won't persist */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Cross-tab sync: another tab's write to our key updates this tab's snapshot.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = load();
      emit();
    }
  });
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(subscribe, getUiPrefs, () => DEFAULT_PREFS);
}
