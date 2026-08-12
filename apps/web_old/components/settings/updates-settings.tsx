"use client";

// Desktop auto-update — a thin presenter over window.telarDesktop.updates
// (wired in apps/desktop/main.js via electron-updater, proxied through the
// Cloudflare R2 update Worker). Browser tabs have no such bridge, so this
// renders a plain "desktop only" notice there instead of dead controls.
//
// Loom Doctrine: reads/writes only the desktop IPC bridge — no engine env,
// no telar.yaml/.telar.

import { useEffect, useState } from "react";
import { DownloadIcon, MonitorIcon, RotateCwIcon } from "lucide-react";
import type { TelarDesktopUpdateStatus, TelarDesktopUpdatePrefsInfo } from "@/types/telar-desktop";
import { SettingsGroup, Row } from "./settings-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// What each channel actually commits you to, in the user's terms rather than
// the build system's. `nightly` is the one that needs saying out loud: it
// publishes on every merge to main and installs itself, so choosing it is
// choosing to run unreviewed-by-you code continuously.
const CHANNEL_HINT: Record<string, string> = {
  beta: "Tested builds, cut deliberately. The safe default.",
  nightly: "Every build from main, as it lands. Expect breakage.",
};

export function UpdatesSettings() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [status, setStatus] = useState<TelarDesktopUpdateStatus>({ status: "not-available" });
  const [checking, setChecking] = useState(false);
  const [prefs, setPrefs] = useState<TelarDesktopUpdatePrefsInfo | null>(null);

  useEffect(() => {
    const updates = window.telarDesktop?.updates;
    if (!updates) return;
    setIsDesktop(true);
    void updates.getPrefs().then(setPrefs);
    return updates.onStatus((s) => {
      setStatus(s);
      if (s.status !== "checking") setChecking(false);
    });
  }, []);

  // Optimistic, then reconciled with what the shell actually stored — the shell
  // validates the channel name, so its answer is the truth and a rejected value
  // must not linger on screen as though it took.
  const savePrefs = async (patch: Partial<TelarDesktopUpdatePrefsInfo>) => {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    const saved = await window.telarDesktop?.updates.setPrefs(patch);
    if (saved) setPrefs((p) => (p ? { ...p, ...saved } : p));
  };

  if (!isDesktop) {
    return (
      <SettingsGroup title="Updates">
        <Row
          icon={MonitorIcon}
          label="Desktop app only"
          hint="Auto-update runs inside the Telar desktop app. This browser tab has no updater to check."
        />
      </SettingsGroup>
    );
  }

  const checkNow = async () => {
    setChecking(true);
    const result = await window.telarDesktop?.updates.check();
    // "unsupported" comes back from the handler rather than over onStatus, so
    // nothing else would clear the spinner or correct the hint for a build that
    // has no update feed baked in (a local unsigned package, or dev).
    if (result?.status === "unsupported") {
      setStatus({ status: "unsupported" });
      setChecking(false);
    }
  };

  // The shell threads the version from `update-available` onto every
  // `downloading` broadcast (main.js), but it's still an optional field on the
  // wire — fall back to unversioned copy rather than ever render "vundefined".
  const hint =
    status.status === "checking"
      ? "Checking for a newer build…"
      : status.status === "available"
        ? status.version
          ? `Downloading v${status.version}…`
          : "Downloading…"
        : status.status === "downloading"
          ? status.version
            ? `Downloading v${status.version}… ${Math.round(status.percent ?? 0)}%`
            : `Downloading… ${Math.round(status.percent ?? 0)}%`
          : status.status === "downloaded"
            ? `v${status.version} is ready to install.`
            : status.status === "error"
              ? `Update check failed: ${status.message}`
              : status.status === "unsupported"
                ? "This build has no update feed — it was packaged locally rather than published to a channel."
                : "You're on the latest build.";

  // Of the six statuses, only two have a useful action: idle/error → check,
  // downloaded → install & restart. `available` and `downloading` are things
  // happening TO you, not decisions waiting on you — offering "Check for
  // updates" there is at best a no-op (the update is already found) and at
  // worst restarts a check for something already arriving. So the control
  // for those two states says what's happening instead of offering a button.
  const control =
    status.status === "downloaded" ? (
      <Button size="sm" onClick={() => void window.telarDesktop?.updates.install()}>
        <DownloadIcon /> Install & restart
      </Button>
    ) : status.status === "available" || status.status === "downloading" ? (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {status.status === "downloading" ? "Downloading…" : "Found"}
      </span>
    ) : (
      <Button size="sm" variant="outline" onClick={checkNow} disabled={checking}>
        {checking ? <Spinner /> : <RotateCwIcon />} Check for updates
      </Button>
    );

  return (
    <SettingsGroup title="Updates" description="Beta and nightly builds check in with a private Cloudflare-hosted update feed.">
      <Row label="Update status" hint={hint} control={control} />
      <Row
        label="Channel"
        hint={
          prefs
            ? (CHANNEL_HINT[prefs.channel] ?? "Which stream of builds this install follows.")
            : "Which stream of builds this install follows."
        }
        control={
          <Select
            value={prefs?.channel ?? "beta"}
            // base-ui hands back `null` for a cleared selection; this Select is
            // never clearable, so that case is ignored rather than written
            // through as a channel of "null".
            onValueChange={(channel) => {
              if (typeof channel === "string") void savePrefs({ channel });
            }}
            disabled={!prefs}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Enumerated by the shell, never hard-coded here — a list that
                  drifted from what is actually published would offer a channel
                  whose feed does not exist. */}
              {(prefs?.channels ?? ["beta"]).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <Row
        label="Install on quit"
        hint={
          prefs?.installOnQuit
            ? "A downloaded update installs itself the next time you quit Telar. Install & restart still works while this is on."
            : "Downloaded updates wait for you to press Install & restart."
        }
        control={
          <Switch
            checked={prefs?.installOnQuit ?? false}
            onCheckedChange={(installOnQuit) => void savePrefs({ installOnQuit })}
            disabled={!prefs}
          />
        }
      />
      {prefs && !prefs.configured && (
        <Row
          icon={MonitorIcon}
          label="No update feed in this build"
          hint="These preferences are saved, but this build was packaged locally rather than published to a channel, so nothing will check or install."
        />
      )}
    </SettingsGroup>
  );
}
