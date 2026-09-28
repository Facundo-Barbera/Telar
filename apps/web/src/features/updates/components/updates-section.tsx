"use client";

import { useEffect, useState } from "react";
import { DownloadIcon, MonitorIcon, PowerIcon, RefreshCwIcon } from "lucide-react";
import { CHANNEL_HINT, desktopUpdates, updateStatusHint, useDesktopUpdate, type UpdatePrefsInfo } from "../desktop-updates";
import { Row, SettingsGroup } from "@/features/settings";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { UpdateToast } from "./update-toast";
import { RestartUpdateDialog } from "./restart-update-dialog";
import { useSessionDefaults } from "@/features/sessions/index";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function UpdatesSection() {
  const { supported: isDesktop, status, action, label, busy, failure, act, restart } = useDesktopUpdate();
  const { defaults, loading: defaultsLoading, save: saveDefaults } = useSessionDefaults();
  const [prefs, setPrefs] = useState<UpdatePrefsInfo | null>(null);

  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    void updates.getPrefs().then(setPrefs);
  }, []);

  const savePrefs = async (patch: Partial<UpdatePrefsInfo>) => {
    setPrefs((current) => (current ? { ...current, ...patch } : current));
    const saved = await desktopUpdates()?.setPrefs(patch);
    if (saved) setPrefs((current) => (current ? { ...current, ...saved } : current));
  };

  if (!isDesktop) {
    return (
      <SettingsGroup title="Updates">
        <Row
          icon={MonitorIcon}
          label="Desktop app only"
          hint="This browser tab has no updater to check."
        />
      </SettingsGroup>
    );
  }

  const control = (
    <span data-slot="update-control" className="relative inline-flex items-center">
      <UpdateToast status={status} />
      <RestartUpdateDialog restart={restart} />
      {action === "restarting" ? (
        <Button size="sm" disabled aria-label={label}>
          <Spinner /> Restarting…
        </Button>
      ) : action === "apply" ? (
        <Button size="sm" onClick={act} aria-label={label}>
          <PowerIcon /> Install &amp; restart
        </Button>
      ) : action === "download" ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" aria-label={label}>
          <DownloadIcon className="size-4" />
          {status.status === "downloading" ? `Downloading… ${Math.round(status.percent ?? 0)}%` : "Downloading…"}
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={act} disabled={busy} aria-label={label}>
          {status.status === "checking" ? <Spinner /> : <RefreshCwIcon />} Check for updates
        </Button>
      )}
    </span>
  );

  return (
    <SettingsGroup title="Updates">
      <Row label="Update status" hint={failure ?? updateStatusHint(status)} control={control} />
      <Row
        label="Channel"
        {...(prefs && CHANNEL_HINT[prefs.channel] ? { hint: CHANNEL_HINT[prefs.channel] } : {})}
        control={
          <Select
            value={prefs?.channel ?? "beta"}
            onValueChange={(channel) => {
              if (typeof channel === "string") void savePrefs({ channel });
            }}
            disabled={!prefs}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(prefs?.channels ?? ["beta"]).map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {channel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <Row
        label="Continue sessions after restarting"
        hint="When Telar restarts to update, the sessions it stopped pick up where they left off."
        info="Only a restart to install an update counts; a crash never resumes anything. Each stopped session gets one message saying Telar restarted, marked as automatic. Terminals and runs are not restarted, and a session you stopped or settled is left alone."
        control={
          <Switch
            aria-label="Continue sessions after restarting"
            checked={defaults.resumeAfterRestart === true}
            onCheckedChange={(resumeAfterRestart) => void saveDefaults({ resumeAfterRestart })}
            disabled={defaultsLoading}
          />
        }
      />
      <Row
        label="Install on quit"
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
          hint="This build was packaged locally, so nothing will check or install. Preferences are still saved."
        />
      )}
    </SettingsGroup>
  );
}
