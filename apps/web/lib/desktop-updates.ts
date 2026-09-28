"use client";

/**
 * The desktop shell's auto-updater. The shell owns the feed, channel preference and
 * downloaded artefact (apps/desktop/main.js); there is no route handler behind this.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createEngineApi } from "@/lib/engine/client";

/** What the shell broadcasts; `restarting` is reported by the shell, not inferred. */
export type UpdateStatus = {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "restarting" | "error" | "unsupported";
  version?: string;
  percent?: number;
  message?: string;
};

/** Persisted in the shell's userData. */
type UpdatePrefs = {
  channel: string;
  installOnQuit: boolean;
};

export type UpdatePrefsInfo = UpdatePrefs & {
  /** Enumerated by the shell, so the UI never hard-codes the list. */
  channels: string[];
  /** False for a locally packaged build with no feed baked in. */
  configured: boolean;
  /** Where the shell writes the updater log. */
  logPath: string;
  /** A Dev-packaged build that updates from the local checkout (`openLocalUpdater`).
   *  Never true alongside `configured`; absent on older shells. */
  localUpdater?: boolean;
};

export type UpdatesBridge = {
  check: () => Promise<{ status: string } | undefined>;
  /** Resolves once the shell has accepted the request, since the process is about to quit.
   *  Older shells answer `undefined`. */
  install: () => Promise<{ status: string } | undefined | void>;
  onStatus: (listener: (status: UpdateStatus) => void) => () => void;
  /** The last broadcast status, since `update-downloaded` is never re-emitted.
   *  Optional on older shells. */
  status?: () => Promise<UpdateStatus | null | undefined>;
  getPrefs: () => Promise<UpdatePrefsInfo>;
  setPrefs: (patch: Partial<UpdatePrefs>) => Promise<UpdatePrefs>;
  /** Busy terminals a restart would end. Optional on older shells. */
  busy?: () => Promise<{ terminals: { count: number; commands: string[] } }>;
  /** Dev builds only: open the local-checkout update window. */
  openLocalUpdater?: () => Promise<{ ok: boolean; error?: string }>;
};

export function desktopUpdates(): UpdatesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { updates?: UpdatesBridge } }).telarDesktop?.updates;
}

export const CHANNEL_HINT: Record<string, string> = {
  beta: "Tested builds, cut deliberately. The safe default.",
  nightly: "Every build from main, as it lands. Expect breakage.",
};

/** Falls back to unversioned copy because `version` is optional on the wire. */
export function updateStatusHint(status: UpdateStatus): string {
  switch (status.status) {
    case "checking":
      return "Checking for a newer build…";
    case "available":
      return status.version ? `Downloading v${status.version}…` : "Downloading…";
    case "downloading":
      return status.version
        ? `Downloading v${status.version}… ${Math.round(status.percent ?? 0)}%`
        : `Downloading… ${Math.round(status.percent ?? 0)}%`;
    case "downloaded":
      return `v${status.version} is ready to install.`;
    case "restarting":
      return status.version ? `Restarting to install v${status.version}…` : "Restarting to install…";
    case "error":
      // The shell also reports stalled or cancelled downloads here, so this is not "check failed".
      return `Update failed: ${status.message}`;
    case "unsupported":
      return "This build has no update feed — it was packaged locally rather than published to a channel.";
    default:
      return "You're on the latest build.";
  }
}

/**
 * Every status lands in one of these, and both surfaces draw the same glyph for it:
 *   `check` asks the feed; `download` is informational; `apply` installs and restarts;
 *   `restarting` means the shell has taken that press.
 */
export type UpdateAction = "check" | "download" | "apply" | "restarting";

export function updateAction(status: UpdateStatus): UpdateAction {
  if (status.status === "restarting") return "restarting";
  if (status.status === "downloaded") return "apply";
  if (status.status === "available" || status.status === "downloading") return "download";
  return "check";
}

/** The control's tooltip and `aria-label`; `failure` overrides everything. */
export function updateLabel(status: UpdateStatus, failure?: string): string {
  if (failure) return failure;
  switch (updateAction(status)) {
    case "restarting":
    case "download":
      return updateStatusHint(status);
    case "apply":
      return status.version ? `Install v${status.version} and restart` : "Install the update and restart";
    default:
      return status.status === "not-available" ? "Check for app updates" : updateStatusHint(status);
  }
}

/**
 * Only unrequested news gets a toast: available, downloaded, restarting. The key changes
 * only when the news does, so re-renders never re-raise a dismissed toast.
 */
export function updateToast(status: UpdateStatus): { key: string; message: string } | null {
  const version = status.version ?? "";
  switch (status.status) {
    case "available":
      return { key: `available:${version}`, message: version ? `v${version} is available — downloading…` : "An update is available — downloading…" };
    case "downloaded":
      return { key: `downloaded:${version}`, message: version ? `v${version} downloaded — restart to install.` : "Update downloaded — restart to install." };
    case "restarting":
      return { key: `restarting:${version}`, message: updateStatusHint(status) };
    default:
      return null;
  }
}

/** How long "Restarting…" may stand before the control reports a failed restart and offers the press again. */
const RESTART_TIMEOUT_MS = 10_000;

/** Feed, the Dev build's local-checkout window, neither, or "could not ask" (retryable). */
type UpdatePath = "feed" | "local" | "none" | "unknown";

export type DesktopUpdate = {
  /** False in a browser tab, where there is no shell bridge. */
  supported: boolean;
  path: UpdatePath;
  status: UpdateStatus;
  action: UpdateAction;
  label: string;
  /** A check in flight, a download arriving, or a restart under way. */
  busy: boolean;
  /** A failure of this surface's own calls. Retryable. */
  failure?: string;
  /** No-op where the state carries no decision; on "apply" it opens the restart confirmation. */
  act: () => void;
  restart: RestartConfirmation;
};

/** Absent counts mean "could not ask" and are not warned about. */
export type RestartImpact = { workingSessions?: number; busyTerminals?: number; commands?: string[] };

export type RestartConfirmation = {
  open: boolean;
  /** Undefined while it is still being asked. */
  impact?: RestartImpact;
  confirm: () => void;
  cancel: () => void;
};

/** Sessions first, then terminals; with nothing running it still asks in a neutral line. */
export function restartDialogCopy(impact: RestartImpact | undefined): { description: string; terminals?: string; commands: string[] } {
  const working = impact?.workingSessions ?? 0;
  const busy = impact?.busyTerminals ?? 0;
  const description =
    working === 0
      ? "Telar closes and reopens on the new version. Nothing is running right now."
      : working === 1
        ? "One session is working. It will stop until Telar reopens."
        : `${working} sessions are working. They will stop until Telar reopens.`;
  return {
    description,
    ...(busy > 0
      ? { terminals: busy === 1 ? "One terminal is running a command, which will be ended:" : `${busy} terminals are running commands, which will be ended:` }
      : {}),
    commands: busy > 0 ? (impact?.commands ?? []) : [],
  };
}

/** Working, or still running background work after the turn. */
export function countWorkingSessions(rows: readonly { activity?: string }[]): number {
  return rows.filter((row) => row.activity === "working" || row.activity === "monitoring").length;
}

const subscribeToNothing = () => () => {};
const shellIsPresent = () => desktopUpdates() !== undefined;
const noShellOnTheServer = () => false;

const say = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The updater state machine shared by both update surfaces. */
export function useDesktopUpdate({ restartTimeoutMs = RESTART_TIMEOUT_MS }: { restartTimeoutMs?: number } = {}): DesktopUpdate {
  // The preload seats the bridge before any page script runs; the server has none.
  const supported = useSyncExternalStore(subscribeToNothing, shellIsPresent, noShellOnTheServer);
  const [path, setPath] = useState<UpdatePath>("unknown");
  const [status, setStatus] = useState<UpdateStatus>({ status: "not-available" });
  const [failure, setFailure] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [impact, setImpact] = useState<RestartImpact>();

  const readPrefs = useCallback(() => {
    const bridge = desktopUpdates();
    if (!bridge) return;
    bridge
      .getPrefs()
      .then((prefs) => {
        setFailure(undefined);
        setPath(prefs.localUpdater ? "local" : prefs.configured ? "feed" : "none");
      })
      .catch((error: unknown) => {
        setPath("unknown");
        setFailure(`Could not read updater state: ${say(error)}. Click to retry.`);
      });
  }, []);

  useEffect(() => {
    const bridge = desktopUpdates();
    if (!bridge) return;
    let live = true;
    /** A push beats the pull whatever order they resolve in, or a slow pull could rewind "downloaded". */
    let pushed = false;
    readPrefs();
    // Ask for the current state: `update-downloaded` is never re-emitted.
    void bridge
      .status?.()
      .then((current) => {
        if (live && !pushed && current && current.status !== "unsupported") setStatus(current);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStatus((next) => {
      if (!live) return;
      pushed = true;
      // "unsupported" is a fact about the build: it retires the control.
      if (next.status === "unsupported") setPath((current) => (current === "feed" ? "none" : current));
      else {
        setFailure(undefined);
        setStatus(next);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [supported, readPrefs]);

  /** The shell promising to restart is not the shell restarting; past the deadline, fall back to Apply. */
  useEffect(() => {
    if (status.status !== "restarting") return;
    const timer = setTimeout(() => {
      setFailure(`The app has not restarted after ${Math.round(restartTimeoutMs / 1000)}s. Click to try again.`);
      setStatus((current) => (current.status === "restarting" ? { ...current, status: "downloaded" } : current));
    }, restartTimeoutMs);
    return () => clearTimeout(timer);
  }, [status, restartTimeoutMs]);

  const action = updateAction(status);
  const busy = action === "download" || action === "restarting" || status.status === "checking";

  const act = useCallback(() => {
    const bridge = desktopUpdates();
    if (!bridge) return;
    if (path === "unknown") return readPrefs();
    const current = updateAction(status);
    if (current === "download" || current === "restarting") return;
    if (current === "apply") {
      /** A restart stops working sessions, so ask first. Either half of the impact may fail and is then omitted. */
      setImpact(undefined);
      setConfirming(true);
      void Promise.all([
        bridge.busy?.().then((result) => result.terminals).catch(() => undefined),
        createEngineApi().liveSessions().then((page) => countWorkingSessions(page.sessions)).catch(() => undefined),
      ]).then(([terminals, workingSessions]) =>
        setImpact({
          ...(workingSessions === undefined ? {} : { workingSessions }),
          ...(terminals ? { busyTerminals: terminals.count, commands: terminals.commands } : {}),
        }),
      );
      return;
    }
    setFailure(undefined);
    setStatus({ status: "checking" });
    void bridge
      .check()
      .then((result) => {
        // "unsupported" comes back from the handler, not over onStatus.
        if (result?.status === "unsupported") setStatus({ status: "unsupported" });
      })
      .catch((error: unknown) => {
        setFailure(`Update check failed: ${say(error)}`);
        // Back to a pressable state rather than a stuck spinner.
        setStatus({ status: "not-available" });
      });
  }, [path, readPrefs, status]);

  const confirm = useCallback(() => {
    const bridge = desktopUpdates();
    setConfirming(false);
    if (!bridge) return;
    setFailure(undefined);
    // Optimistic: the shell broadcasts `restarting` only after the IPC round-trip.
    setStatus((last) => ({ ...last, status: "restarting" }));
    void bridge.install().catch((error: unknown) => {
      setFailure(`Install failed: ${say(error)}`);
      setStatus((last) => (last.status === "restarting" ? { ...last, status: "downloaded" } : last));
    });
  }, []);
  const cancel = useCallback(() => setConfirming(false), []);

  return {
    supported,
    path,
    status,
    action,
    label: updateLabel(status, failure),
    busy,
    failure,
    act,
    restart: { open: confirming, ...(impact ? { impact } : {}), confirm, cancel },
  };
}
