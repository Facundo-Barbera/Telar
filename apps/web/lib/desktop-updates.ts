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

/** What the shell broadcasts as an update moves through its lifecycle. */
export type UpdateStatus = {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported";
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
};

export type UpdatesBridge = {
  check: () => Promise<{ status: string } | undefined>;
  install: () => Promise<void>;
  onStatus: (listener: (status: UpdateStatus) => void) => () => void;
  getPrefs: () => Promise<UpdatePrefsInfo>;
  setPrefs: (patch: Partial<UpdatePrefs>) => Promise<UpdatePrefs>;
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
    case "error":
      return `Update check failed: ${status.message}`;
    case "unsupported":
      return "This build has no update feed — it was packaged locally rather than published to a channel.";
    default:
      return "You're on the latest build.";
  }
}

/**
 * Which control belongs beside that sentence.
 *
 * OF THE SEVEN STATUSES ONLY TWO CARRY A DECISION: idle or failed → check;
 * downloaded → install and restart. `available` and `downloading` are things
 * happening TO you, not choices waiting on you — offering "Check for updates"
 * there is at best a no-op (the update is already found) and at worst restarts a
 * check for something already arriving.
 */
export function updateAction(status: UpdateStatus): "install" | "progress" | "check" {
  if (status.status === "downloaded") return "install";
  if (status.status === "available" || status.status === "downloading") return "progress";
  return "check";
}
