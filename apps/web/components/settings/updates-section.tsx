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

import { useEffect, useState, useSyncExternalStore } from "react";
import { DownloadIcon, MonitorIcon, RotateCwIcon } from "lucide-react";
import { CHANNEL_HINT, desktopUpdates, updateAction, updateStatusHint, type UpdatePrefsInfo, type UpdateStatus } from "@/lib/desktop-updates";
import { Row, SettingsGroup } from "./settings-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * WHETHER THERE IS A SHELL AT ALL — an external fact, read as one.
 *
 * The donor set this with `setIsDesktop(true)` inside an effect, which this
 * app's lint rule refuses (`react-hooks/set-state-in-effect`) and is right to:
 * it is a cascading render for something that was already true before React
 * started. It cannot simply be read during render either — the server has no
 * `window`, and disagreeing with the client is a hydration mismatch.
 *
 * `useSyncExternalStore` is the documented answer to exactly that pair, and it
 * is what `theme-provider.tsx` already uses for localStorage. SUBSCRIBE IS A
 * NO-OP because the preload injects the bridge before any page script runs and
 * never removes it: there is no change to hear about.
 */
const subscribeToNothing = () => () => {};
const shellIsPresent = () => desktopUpdates() !== undefined;
const noShellOnTheServer = () => false;

export function UpdatesSection() {
  const isDesktop = useSyncExternalStore(subscribeToNothing, shellIsPresent, noShellOnTheServer);
  const [status, setStatus] = useState<UpdateStatus>({ status: "not-available" });
  const [checking, setChecking] = useState(false);
  const [prefs, setPrefs] = useState<UpdatePrefsInfo | null>(null);

  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    void updates.getPrefs().then(setPrefs);
    return updates.onStatus((next) => {
      setStatus(next);
      if (next.status !== "checking") setChecking(false);
    });
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
          hint="Auto-update runs inside the Telar desktop app. This browser tab has no updater to check."
        />
      </SettingsGroup>
    );
  }

  const checkNow = async () => {
    setChecking(true);
    const result = await desktopUpdates()?.check();
    // "unsupported" comes back from the handler rather than over onStatus, so
    // nothing else would clear the spinner or correct the hint for a build that
    // has no update feed baked in (a local package, or dev).
    if (result?.status === "unsupported") {
      setStatus({ status: "unsupported" });
      setChecking(false);
    }
  };

  const action = updateAction(status);
  const control =
    action === "install" ? (
      <Button size="sm" onClick={() => void desktopUpdates()?.install()}>
        <DownloadIcon /> Install &amp; restart
      </Button>
    ) : action === "progress" ? (
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
      <Row label="Update status" hint={updateStatusHint(status)} control={control} />
      <Row
        label="Channel"
        hint={prefs ? (CHANNEL_HINT[prefs.channel] ?? "Which stream of builds this install follows.") : "Which stream of builds this install follows."}
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
