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
import type { TelarDesktopUpdateStatus } from "@/types/telar-desktop";
import { SettingsGroup, Row } from "./settings-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function UpdatesSettings() {
  const [isDesktop, setIsDesktop] = useState(false);
  const [status, setStatus] = useState<TelarDesktopUpdateStatus>({ status: "not-available" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const updates = window.telarDesktop?.updates;
    if (!updates) return;
    setIsDesktop(true);
    return updates.onStatus((s) => {
      setStatus(s);
      if (s.status !== "checking") setChecking(false);
    });
  }, []);

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

  const hint =
    status.status === "checking"
      ? "Checking for a newer build…"
      : status.status === "available"
        ? `Downloading v${status.version}…`
        : status.status === "downloading"
          ? `Downloading v${status.version}… ${Math.round(status.percent ?? 0)}%`
          : status.status === "downloaded"
            ? `v${status.version} is ready to install.`
            : status.status === "error"
              ? `Update check failed: ${status.message}`
              : status.status === "unsupported"
                ? "This build has no update feed — it was packaged locally rather than published to a channel."
                : "You're on the latest build.";

  return (
    <SettingsGroup title="Updates" description="Beta and nightly builds check in with a private Cloudflare-hosted update feed.">
      <Row
        label="Update status"
        hint={hint}
        control={
          status.status === "downloaded" ? (
            <Button size="sm" onClick={() => void window.telarDesktop?.updates.install()}>
              <DownloadIcon /> Install & restart
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={checkNow} disabled={checking}>
              {checking ? <Spinner /> : <RotateCwIcon />} Check for updates
            </Button>
          )
        }
      />
    </SettingsGroup>
  );
}
