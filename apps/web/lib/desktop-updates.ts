"use client";

/**
 * The desktop shell's auto-updater, as this cockpit sees it.
 *
 * A LOCAL STRUCTURAL TYPE AND AN ACCESSOR, not a global `Window` augmentation —
 * the same shape `choose-directory.ts` uses, and for the same reason: a global
 * declaration would imply the bridge is always there, and in a browser tab it
 * never is.
 *
 * NOTHING HERE TALKS TO A SERVER. Updates are a property of THIS INSTALLATION,
 * not of the engine or of a project: the shell owns the feed, the channel
 * preference and the downloaded artefact (apps/desktop/main.js), and the cockpit
 * only presents them. That is why there is no route handler behind this file.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * What the shell broadcasts as an update moves through its lifecycle.
 *
 * `restarting` IS A STATE THE SHELL REPORTS, not one the renderer infers.
 * `quitAndInstall()` stages the update and only then quits, and between those
 * two the app simply sits there — which read as a dead button, and a second
 * press produced a native warning instead of anything useful (issue #389). The
 * shell now says "I am restarting" before it goes, so both surfaces can show it
 * rather than guess at it.
 */
export type UpdateStatus = {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "restarting" | "error" | "unsupported";
  version?: string;
  percent?: number;
  message?: string;
};

/** Which stream of builds this INSTALL follows, and whether quitting is also
 *  consent to install. Persisted in the shell's userData. */
export type UpdatePrefs = {
  channel: string;
  installOnQuit: boolean;
};

export type UpdatePrefsInfo = UpdatePrefs & {
  /** The channels this build knows how to follow — ENUMERATED BY THE SHELL so
   *  the UI never hard-codes a list that could drift from what is published. */
  channels: string[];
  /** False for a locally-packaged build with no feed baked in. The controls
   *  still render, and say why they will not do anything. */
  configured: boolean;
  /** Where the shell writes the updater log, so it is findable without knowing
   *  where userData lives. */
  logPath: string;
  /** True on a Dev-packaged build: updates come from the LOCAL CHECKOUT
   *  through the shell's explicit window (`openLocalUpdater`), never from a
   *  published feed. Never true alongside `configured`. Optional because an
   *  older shell does not report it. */
  localUpdater?: boolean;
};

export type UpdatesBridge = {
  check: () => Promise<{ status: string } | undefined>;
  /** Resolves as soon as the shell has ACCEPTED the request — the process is
   *  about to quit, so nothing useful can be awaited past that. An older shell
   *  answers `undefined`; a current one says what it did with the press. */
  install: () => Promise<{ status: string } | undefined | void>;
  onStatus: (listener: (status: UpdateStatus) => void) => () => void;
  /** The LAST status the shell broadcast, for a renderer that mounted after
   *  it — `update-downloaded` is never re-emitted, so without this a reload
   *  loses the "restart to install" state. Optional on older shells. */
  status?: () => Promise<UpdateStatus | null | undefined>;
  getPrefs: () => Promise<UpdatePrefsInfo>;
  setPrefs: (patch: Partial<UpdatePrefs>) => Promise<UpdatePrefs>;
  /** Dev builds only: open the local-checkout update window. */
  openLocalUpdater?: () => Promise<{ ok: boolean; error?: string }>;
};

export function desktopUpdates(): UpdatesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { updates?: UpdatesBridge } }).telarDesktop?.updates;
}

/**
 * What each channel actually commits you to, in the reader's terms rather than
 * the build system's.
 *
 * `nightly` IS THE ONE THAT NEEDS SAYING OUT LOUD: it publishes on every merge
 * to main and installs itself, so choosing it is choosing to run continuously
 * updated, unreviewed-by-you code.
 */
export const CHANNEL_HINT: Record<string, string> = {
  beta: "Tested builds, cut deliberately. The safe default.",
  nightly: "Every build from main, as it lands. Expect breakage.",
};

/**
 * The sentence under "Update status".
 *
 * PURE, AND EXPORTED, so the wording is testable without a shell. Every branch
 * here was a real state somebody had to read and act on; the two that carry a
 * version fall back to unversioned copy rather than ever rendering
 * "vundefined", because `version` is optional on the wire.
 */
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
      // PRESENT TENSE, because it is happening: the shell has taken the press
      // and is staging the update before it quits. The old silence here is the
      // stall #389 is about.
      return status.version ? `Restarting to install v${status.version}…` : "Restarting to install…";
    case "error":
      // "Update failed", not "Update CHECK failed": the shell reports a stalled
      // or cancelled DOWNLOAD through this same status (issue #317), and the
      // old prefix told the reader the wrong thing had gone wrong.
      return `Update failed: ${status.message}`;
    case "unsupported":
      return "This build has no update feed — it was packaged locally rather than published to a channel.";
    default:
      return "You're on the latest build.";
  }
}

/**
 * THE CONTROL HAS THREE STATES AND A FOURTH IT PASSES THROUGH. Every status the
 * shell can broadcast lands in exactly one of them, and both surfaces draw the
 * same glyph for the same one — the point of #389, where an idle button drew a
 * DOWNLOAD arrow for "Check for updates" and so read as "download" in the one
 * state where nothing was being downloaded.
 *
 *   · `check`      — idle, not-available, checking, failed, unsupported. The
 *     only state where pressing asks the feed anything.
 *   · `download`   — available or downloading. A thing happening TO you, not a
 *     choice waiting on you: the glyph reports it and the press does nothing.
 *   · `apply`      — downloaded. Install and restart, the one destructive press.
 *   · `restarting` — the shell has taken that press and is going down.
 */
export type UpdateAction = "check" | "download" | "apply" | "restarting";

export function updateAction(status: UpdateStatus): UpdateAction {
  if (status.status === "restarting") return "restarting";
  if (status.status === "downloaded") return "apply";
  if (status.status === "available" || status.status === "downloading") return "download";
  return "check";
}

/**
 * The one sentence the control carries — its tooltip, its `aria-label`, and the
 * only place a failure of this surface's OWN calls is ever explained.
 *
 * `failure` WINS OVER EVERYTHING. It is the state nothing else can describe: a
 * rejected IPC call, or an install that was accepted and then did not happen.
 * Whatever the shell last said about the update is no longer the thing the
 * reader needs.
 */
export function updateLabel(status: UpdateStatus, failure?: string): string {
  if (failure) return failure;
  switch (updateAction(status)) {
    case "restarting":
    case "download":
      return updateStatusHint(status);
    case "apply":
      return status.version ? `Install v${status.version} and restart` : "Install the update and restart";
    default:
      // An idle control offers the ACTION, not a status report; the three
      // states that have something to report keep their sentence.
      return status.status === "not-available" ? "Check for app updates" : updateStatusHint(status);
  }
}

/**
 * WHICH MOMENTS DESERVE A TOAST, and what it says.
 *
 * EXACTLY THREE, and every one of them is news that arrived without being
 * asked for: a build was published, it finished downloading, the app is going
 * down to install it. `checking` and `not-available` are answers to a press the
 * reader just made and are already on the control they pressed — a toast for
 * those is a notification that you did the thing you just did.
 *
 * The KEY is what makes a toast one toast: it changes when the news changes, so
 * a re-render (or a `downloading` percent ticking past) never re-raises one
 * that has already been read and dismissed.
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

/**
 * HOW LONG "Restarting…" IS ALLOWED TO BE TRUE.
 *
 * `quitAndInstall()` stages the archive and then quits, and a staging that
 * fails quietly leaves the app running with a spinner that never ends — the
 * exact stall reported in #389. Ten seconds is far longer than a real restart
 * takes to begin and short enough that a person has not yet decided the app is
 * broken; past it the control says so and offers the press again.
 */
export const RESTART_TIMEOUT_MS = 10_000;

/** Which updater THIS INSTALL has: the published feed, the Dev build's
 *  local-checkout window, neither, or "could not ask" (retryable). */
export type UpdatePath = "feed" | "local" | "none" | "unknown";

export type DesktopUpdate = {
  /** Whether there is a shell bridge at all. False in a browser tab, where
   *  there is no updater to draw and no toast to raise. */
  supported: boolean;
  path: UpdatePath;
  status: UpdateStatus;
  action: UpdateAction;
  /** The control's sentence — tooltip, `aria-label`, and failure explanation. */
  label: string;
  /** True while the control must not be pressed: a check in flight, a download
   *  arriving, a restart under way. */
  busy: boolean;
  /** A failure of THIS surface's own calls — a rejected check or install, or a
   *  restart that never happened. Retryable, never silently swallowed. */
  failure?: string;
  /** What a press does, by state. A no-op where the state carries no decision. */
  act: () => void;
};

const subscribeToNothing = () => () => {};
const shellIsPresent = () => desktopUpdates() !== undefined;
const noShellOnTheServer = () => false;

const say = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * THE UPDATER, AS ONE STATE MACHINE — the bridge wiring both surfaces used to
 * keep a copy of.
 *
 * They had drifted, which is what #389 is really about: the footer pulled the
 * last status on mount (so a remount recovered "restart to install") and the
 * settings pane did not; the settings pane cleared its spinner for an
 * unsupported build and the footer did not. One of them was right about each,
 * and neither was right about both. Everything below is the union of what the
 * two had learned, stated once.
 */
export function useDesktopUpdate({ restartTimeoutMs = RESTART_TIMEOUT_MS }: { restartTimeoutMs?: number } = {}): DesktopUpdate {
  // An external fact, read as one: the preload seats the bridge before any page
  // script runs, and the server has no `window` to agree with.
  const supported = useSyncExternalStore(subscribeToNothing, shellIsPresent, noShellOnTheServer);
  const [path, setPath] = useState<UpdatePath>("unknown");
  const [status, setStatus] = useState<UpdateStatus>({ status: "not-available" });
  const [failure, setFailure] = useState<string>();

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
        // NOT a permanent hide: the control stays, says why, and retries.
        setPath("unknown");
        setFailure(`Could not read updater state: ${say(error)}. Click to retry.`);
      });
  }, []);

  useEffect(() => {
    const bridge = desktopUpdates();
    if (!bridge) return;
    let live = true;
    /**
     * A PUSH BEATS A PULL, WHATEVER ORDER THEY RESOLVE IN. The pull below is
     * an async IPC round-trip asking what state we MISSED; a push that lands
     * while it is in flight is newer by construction. Without this flag a
     * slow `status()` answering "downloading 40%" would rewind a
     * "downloaded" that had already arrived — and downloaded is the one
     * state that never comes again.
     */
    let pushed = false;
    readPrefs();
    // The CURRENT state, not just future pushes: `update-downloaded` is never
    // re-emitted, so a remounted surface must ask what it missed.
    void bridge
      .status?.()
      .then((current) => {
        if (live && !pushed && current && current.status !== "unsupported") setStatus(current);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStatus((next) => {
      if (!live) return;
      pushed = true;
      // "unsupported" is a fact about the BUILD, not a step in an update's
      // life: it retires the control rather than describing it.
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

  /**
   * THE RESTART HAS A DEADLINE. The shell promising to go is not the shell
   * going — see RESTART_TIMEOUT_MS. When the deadline passes the update is
   * still downloaded and still installable, so the control returns to Apply
   * with a sentence saying what happened, which is the retry the issue asks
   * for in place of a native warning.
   */
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
    // Nothing to decide: a download is arriving, or the app is on its way down.
    if (current === "download" || current === "restarting") return;
    if (current === "apply") {
      setFailure(undefined);
      // OPTIMISTIC, AND THEN CONFIRMED. The shell broadcasts `restarting` too,
      // but only after the IPC round-trip — and the whole complaint was a
      // button that looked inert in exactly that gap.
      setStatus((last) => ({ ...last, status: "restarting" }));
      void bridge.install().catch((error: unknown) => {
        setFailure(`Install failed: ${say(error)}`);
        setStatus((last) => (last.status === "restarting" ? { ...last, status: "downloaded" } : last));
      });
      return;
    }
    setFailure(undefined);
    setStatus({ status: "checking" });
    void bridge
      .check()
      .then((result) => {
        // "unsupported" comes back from the handler rather than over onStatus,
        // so nothing else would clear the spinner for a build with no feed.
        if (result?.status === "unsupported") setStatus({ status: "unsupported" });
      })
      .catch((error: unknown) => {
        setFailure(`Update check failed: ${say(error)}`);
        // Back to a state that can be pressed again — a spinner left spinning
        // on a rejected call is the same stall in a different place.
        setStatus({ status: "not-available" });
      });
  }, [path, readPrefs, status]);

  return { supported, path, status, action, label: updateLabel(status, failure), busy, failure, act };
}
