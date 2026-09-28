"use client";

/**
 * Desktop auto-update — a thin presenter over the shell's updates bridge.
 *
 * PORTED FROM the frozen app's `components/settings/updates-settings.tsx`, with
 * its copy intact. The deviations, both named where they happen: the status
 * sentence and the choice of control moved into `lib/desktop-updates.ts` so they
 * can be tested without a shell, and the bridge is reached through an accessor
 * rather than `window.telarDesktop!` (this cockpit also runs in a browser tab,
 * where there is no bridge at all).
 *
 * Reads and writes only the desktop IPC bridge — no engine call, no route
 * handler. An update is a property of this installation.
 */

import { useEffect, useState } from "react";
import { DownloadIcon, MonitorIcon, PowerIcon, RefreshCwIcon } from "lucide-react";
import { CHANNEL_HINT, desktopUpdates, updateStatusHint, useDesktopUpdate, type UpdatePrefsInfo } from "@/lib/desktop-updates";
import { Row, SettingsGroup } from "./settings-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { UpdateToast } from "@/components/ui/update-toast";
import { RestartUpdateDialog } from "@/components/ui/restart-update-dialog";
import { useSessionDefaults } from "@/lib/session-defaults";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * WHETHER THERE IS A SHELL AT ALL, what the updater is doing, and what a press
 * would mean — all of it read from `useDesktopUpdate()`, which is the same
 * state machine the sidebar footer renders from.
 *
 * THAT SHARING IS THE POINT OF #389. This pane and the rail each used to wire
 * the bridge themselves and had drifted apart: one recovered the "restart to
 * install" state after a remount and the other did not, one cleared its spinner
 * for a build with no feed and the other did not. The prefs below (channel,
 * install-on-quit) stay here, because they are this pane's alone.
 */
export function UpdatesSection() {
  const { supported: isDesktop, status, action, label, busy, failure, act, restart } = useDesktopUpdate();
  const { defaults, loading: defaultsLoading, save: saveDefaults } = useSessionDefaults();
  const [prefs, setPrefs] = useState<UpdatePrefsInfo | null>(null);

  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    void updates.getPrefs().then(setPrefs);
  }, []);

  // Optimistic, then reconciled with what the shell actually stored — the shell
  // validates the channel name, so its answer is the truth and a rejected value
  // must not linger on screen as though it took.
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

  /**
   * THE SAME THREE STATES AS THE RAIL, and the same glyphs — check, download,
   * apply — so a person who learned the control in one surface has not learned
   * a second one here. Only the words differ, because there is room for them.
   */
  const control = (
    // Positioned for the toast, which hangs over this row rather than in a
    // corner of the window.
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
    // NO CAPTION: every row here carries a LIVE sentence — what the updater is
    // doing, what the chosen channel means — and a standing caption over three
    // of those is the doubling #357 is about.
    <SettingsGroup title="Updates">
      {/* A FAILURE OF THIS SURFACE'S OWN CALLS REPLACES THE STATUS SENTENCE —
          a rejected install, or a restart that never happened, is what the
          reader needs to act on, not what the update was doing before it. */}
      <Row label="Update status" hint={failure ?? updateStatusHint(status)} control={control} />
      <Row
        label="Channel"
        /* NO SUB-LINE WHEN THERE IS NOTHING SPECIFIC TO SAY (#364). The fallback
           was "Which stream of builds this install follows" over a select whose
           options ARE the streams — the control restating itself, which is the
           one thing a hint may never be. What survives is `CHANNEL_HINT`: what
           the CHOSEN channel actually means, which the options cannot say. */
        {...(prefs && CHANNEL_HINT[prefs.channel] ? { hint: CHANNEL_HINT[prefs.channel] } : {})}
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
