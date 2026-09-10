/**
 * THE FIXTURE'S FAKE SHELL — a scripted `UpdatesBridge` plus the controls that
 * drive it, as a MODULE rather than as variables the harness component
 * reaches into.
 *
 * That shape is the point twice over. It is how the component sees the real
 * thing (an object obtained from outside React, whose methods you call), and
 * it keeps every mutation inside this module: a React component that assigned
 * to module-scope state in an event handler would be reaching across a
 * boundary the compiler is right to refuse. The harness only ever CALLS the
 * functions below and READS through `subscribe`/`snapshot`.
 */
import type { UpdatePrefsInfo, UpdateStatus, UpdatesBridge } from "../../lib/desktop-updates";

export type ShellMode = "feed" | "dev" | "prefs-fail";

const listeners = new Set<(status: UpdateStatus) => void>();
const watchers = new Set<() => void>();

/** Everything the script decides, mutated only by the functions below. */
const state = {
  mode: "feed" as ShellMode,
  rejectCheck: false,
  rejectInstall: false,
  /** What `status()` answers — the state a remount must recover. */
  current: null as UpdateStatus | null,
  /** Hold `status()` unresolved until released, to drive the pull/push race. */
  deferStatus: false,
};
let releaseStatus: (() => void) | null = null;
const calls: string[] = [];

// ── the ledger, as an external store ──────────────────────────────────────
// A CACHED STRING, rebuilt only when something changes: `useSyncExternalStore`
// demands a referentially stable snapshot, and composing it per render would
// loop forever.
let ledger = renderLedger();
function renderLedger(): string {
  return (
    `mode=${state.mode} rejectCheck=${state.rejectCheck} rejectInstall=${state.rejectInstall} ` +
    `deferStatus=${state.deferStatus} current=${state.current?.status ?? "null"} · calls: ${calls.join(", ") || "(none)"}`
  );
}
function changed() {
  ledger = renderLedger();
  for (const watcher of watchers) watcher();
}

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
export function snapshot(): string {
  return ledger;
}

function record(call: string) {
  calls.push(call);
  changed();
}

// ── the bridge itself ─────────────────────────────────────────────────────
export const bridge: UpdatesBridge = {
  check: async () => {
    record("check");
    if (state.rejectCheck) throw new Error("feed unreachable (scripted)");
    push({ status: "checking" });
    return { status: "checking" };
  },
  install: async () => {
    record("install");
    if (state.rejectInstall) throw new Error("squirrel refused (scripted)");
  },
  onStatus: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  status: async () => {
    record("status");
    if (state.deferStatus) {
      await new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      record("status:released");
    }
    return state.current;
  },
  getPrefs: async () => {
    record("getPrefs");
    if (state.mode === "prefs-fail") throw new Error("prefs store unreadable (scripted)");
    return {
      channel: "nightly",
      installOnQuit: false,
      channels: ["beta", "nightly"],
      configured: state.mode === "feed",
      localUpdater: state.mode === "dev",
      logPath: "/dev/null",
    } as UpdatePrefsInfo;
  },
  setPrefs: async () => ({ channel: "nightly", installOnQuit: false }),
  openLocalUpdater: async () => {
    record("openLocalUpdater");
    return { ok: true };
  },
};

/** Seat the bridge where `desktopUpdates()` looks for it. Called at module
 *  load, so the component resolves it through the production accessor. */
(window as unknown as { telarDesktop: { updates: UpdatesBridge } }).telarDesktop = { updates: bridge };

// ── the controls the harness calls ────────────────────────────────────────

/** Broadcast a status, as the shell's `broadcastUpdateStatus` does. */
export function push(status: UpdateStatus): void {
  for (const listener of listeners) listener(status);
  changed();
}

/** Which BUILD this is. The harness remounts alongside this, because a build
 *  cannot turn into another build while running. */
export function setMode(mode: ShellMode): void {
  state.mode = mode;
  changed();
}

export function toggleCheckReject(): void {
  state.rejectCheck = !state.rejectCheck;
  changed();
}

export function toggleInstallReject(): void {
  state.rejectInstall = !state.rejectInstall;
  changed();
}

export function setCurrent(status: UpdateStatus | null): void {
  state.current = status;
  changed();
}

/** Race step 1: hold the next `status()` pull open, answering stale state. */
export function deferStatusPull(stale: UpdateStatus): void {
  state.deferStatus = true;
  state.current = stale;
  releaseStatus = null;
  changed();
}

/** Race step 3: let the held pull resolve, after a push has already landed. */
export function releaseStatusPull(): void {
  releaseStatus?.();
  releaseStatus = null;
  state.deferStatus = false;
  changed();
}

/** Only the harness's own navigation callback needs this. */
export function recordNavigate(): void {
  record("navigate");
}
