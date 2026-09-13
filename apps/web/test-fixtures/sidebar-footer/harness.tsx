/**
 * A browser fixture for the REAL sidebar footer
 * (components/app-sidebar-footer.tsx) reached through the REAL
 * `desktopUpdates()` wrapper: scripted-shell.ts seats its bridge on
 * `window.telarDesktop` at module load, before the component is imported, so
 * the component resolves it exactly as it does in the shell.
 *
 * MODE IS A PROPERTY OF THE INSTALL, SO CHANGING IT REMOUNTS. `getPrefs` is
 * read once per mount because `DEV_BUILD` cannot change under a running app;
 * a mode button that only flipped the script would leave the old button on
 * screen and read as a bug in the component. Each mode button remounts the
 * footer, which is the real-world event it stands for — launching that build.
 *
 * Scenarios: the published channel's states, a REJECTING bridge, an
 * already-downloaded REMOUNT (the pull contract), a failing getPrefs with
 * retry, the Dev build (which renders NOTHING here — its local-checkout
 * updater is a File-menu item), and the PULL/PUSH RACE — a deferred
 * `status()` answering with older state after a push has already landed.
 * `BEFORE=1 bun build.mjs` bundles the same page with the race guard removed.
 * No Electron, no real updater.
 */
import { createElement as h, StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  deferStatusPull,
  push,
  recordNavigate,
  releaseStatusPull,
  setCurrent,
  setMode,
  snapshot,
  subscribe,
  toggleCheckReject,
  toggleInstallReject,
  type ShellMode,
} from "./scripted-shell";
import type { UpdateStatus } from "../../lib/desktop-updates";

// Imported only after the bridge is seated: the component reads it through
// the production `desktopUpdates()` accessor at render time.
const { AppSidebarFooterRow } = await import("../../components/app-sidebar-footer");

const STATES: { name: string; status: UpdateStatus }[] = [
  { name: "idle", status: { status: "not-available" } },
  { name: "checking", status: { status: "checking" } },
  { name: "available (toast)", status: { status: "available", version: "0.2.9" } },
  { name: "downloading 37%", status: { status: "downloading", version: "0.2.9", percent: 37 } },
  { name: "downloaded / ready", status: { status: "downloaded", version: "0.2.9" } },
  // The state that used to be a stall: pressing Apply now switches here at
  // once, and the shell broadcasts it too (#389).
  { name: "restarting", status: { status: "restarting", version: "0.2.9" } },
  { name: "error", status: { status: "error", message: "feed unreachable" } },
];

const STALE_PULL: UpdateStatus = { status: "downloading", version: "0.3.1", percent: 40 };
const READY: UpdateStatus = { status: "downloaded", version: "0.3.1" };

function Harness() {
  const [mounted, setMounted] = useState(1);
  // The ledger lives in the scripted shell; this reads it the way React reads
  // any store outside itself.
  const ledger = useSyncExternalStore(subscribe, snapshot, snapshot);
  const remount = () => setMounted((value) => value + 1);

  const control = (name: string, act: () => void) =>
    h("button", { key: name, className: "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent", onClick: act }, name);

  /** A mode is which BUILD this is, so switching one relaunches the footer. */
  const modeControl = (name: string, mode: ShellMode) =>
    control(name, () => {
      setMode(mode);
      remount();
    });

  return h(
    "div",
    { className: "flex min-h-screen flex-col gap-4 bg-background p-8 text-foreground" },
    h("h1", { className: "text-lg font-semibold" }, "Sidebar footer fixture — real component, scripted updater bridge"),
    h(
      "p",
      { className: "max-w-2xl text-sm text-muted-foreground" },
      "Mode buttons remount the footer: which updater an install has is read once per mount, because a build cannot change into another build while running.",
    ),
    h("div", { className: "flex flex-wrap gap-2" }, ...STATES.map((state) => control(state.name, () => push(state.status)))),
    h(
      "div",
      { className: "flex flex-wrap gap-2" },
      modeControl("mode: normal feed (remounts)", "feed"),
      modeControl("mode: DEV build (remounts)", "dev"),
      modeControl("mode: prefs FAIL (remounts)", "prefs-fail"),
      control("check rejects: toggle", toggleCheckReject),
      control("install rejects: toggle", toggleInstallReject),
      control("script current = downloaded", () => setCurrent(READY)),
      control("script current = downloading 40%", () => setCurrent(STALE_PULL)),
      control("REMOUNT footer", remount),
    ),
    // The pull/push race, driven in the order the shell can produce it.
    h(
      "div",
      { className: "flex flex-wrap gap-2" },
      control("RACE 1 · defer status() + remount", () => {
        deferStatusPull(STALE_PULL);
        remount();
      }),
      control("RACE 2 · push downloaded", () => push(READY)),
      control("RACE 3 · release the stale pull", releaseStatusPull),
    ),
    h(
      "div",
      { className: "w-64 rounded-lg border border-border bg-sidebar text-sidebar-foreground" },
      h(AppSidebarFooterRow, { key: mounted, onNavigate: recordNavigate }),
    ),
    h("div", { id: "ledger", className: "max-w-2xl font-mono text-xs text-muted-foreground" }, `mount=#${mounted} · ${ledger}`),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(Harness)));
