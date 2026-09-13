"use client";

/**
 * BROWSER PROFILES — every Chromium identity this install has, and the one place
 * to name, default, and tidy them.
 *
 * WHY THIS IS IN SETTINGS AND NOT ONLY IN THE PANEL. A profile is not a property
 * of the session you happen to have open: it outlives every session, several
 * projects may share one, and after the per-project era an install can carry a
 * handful of records nobody chose. Managing that from inside one session's browser
 * panel meant you could only ever see it from wherever you were standing.
 *
 * ONE DEFAULT, AND IT SAYS WHAT THAT MEANS. Every project that never picked a
 * profile browses in the default, so changing the default moves all of them — the
 * row says so rather than leaving it to be discovered.
 *
 * NOTHING HERE DELETES A COOKIE JAR. Delete forgets a record, and the shell
 * refuses it while the default, a project, or a live session still points at the
 * profile. The partition on disk is never removed, by anything.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleUserRoundIcon, MonitorIcon } from "lucide-react";
import {
  desktopBrowserProfiles,
  describeProfileUse,
  profileNameProblem,
  whyUndeletable,
  type BrowserProfile,
} from "@/lib/desktop-browser-profiles";
import { NewBrowserProfileDialog } from "@/components/browser-profile-prompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

export function BrowserProfilesSection() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [creating, setCreating] = useState(false);

  const bridge = desktopBrowserProfiles();

  const load = useCallback(async () => {
    const reader = desktopBrowserProfiles();
    if (!reader) return;
    try {
      setProfiles((await reader.profiles()).profiles);
      setError(undefined);
    } catch {
      setError("The desktop shell did not answer; its browser host may still be starting.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /** Every write lands the shell's own answer, because the shell is what
   *  validates: a refusal must show up as the refusal, not as a row that moved. */
  const act = async (id: string, write: () => Promise<{ profiles: BrowserProfile[] }>) => {
    setBusy(id);
    setError(undefined);
    try {
      setProfiles((await write()).profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be made.");
      await load();
    } finally {
      setBusy(undefined);
    }
  };

  if (!bridge) {
    return (
      <SettingsGroup title="Browser profiles" description="The identities Telar's own browser signs in as.">
        <Row icon={MonitorIcon} label="Desktop app only" hint="This browser tab has no browser host to keep profiles for." />
      </SettingsGroup>
    );
  }

  return (
    <>
      {/* THE SECOND SENTENCE WAS THE LIST'S JOB. It said that projects sharing
          a profile share a sign-in and that everything else browses in the
          default — which is exactly what `describeProfileUse` prints on each
          row, per profile, with the actual count. A header that narrates its
          own list makes the reader parse the sentence and then parse the list
          to check it against. */}
      <SettingsGroup
        title="Browser profiles"
        description="Each one is a separate set of cookies and logins for Telar's own browser."
        action={
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            New profile
          </Button>
        }
      >
        {error && <p className="text-xs text-destructive">{error}</p>}
        {profiles === undefined && !error && <Spinner className="size-4" />}
        {profiles?.map((profile) => (
          <Row
            key={profile.id}
            icon={CircleUserRoundIcon}
            label={
              <span className="flex items-center gap-2">
                <span className="truncate">{profile.label}</span>
                {/* NOT ON A PROFILE ALREADY CALLED "DEFAULT" (#357): the row
                    read "Default Default", which is a badge repeating the name
                    beside it rather than adding a fact. A profile the user
                    named something else still needs the mark. */}
                {profile.isDefault && profile.label.trim().toLowerCase() !== "default" && <Badge variant="secondary">Default</Badge>}
                {profile.account && <span className="truncate font-mono text-[0.625rem] text-muted-foreground">{profile.account}</span>}
              </span>
            }
            hint={describeProfileUse(profile)}
            control={
              <div className="flex items-center gap-1">
                {!profile.isDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === profile.id}
                    title="Every project that has not picked a profile browses here from now on. Projects already assigned somewhere are not moved."
                    onClick={() => void act(profile.id, () => bridge.setDefaultProfile(profile.id))}
                  >
                    Make default
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setRenaming(renaming === profile.id ? undefined : profile.id)}>
                  {renaming === profile.id ? "Done" : "Rename"}
                </Button>
                {bridge.deleteProfile && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === profile.id || Boolean(whyUndeletable(profile))}
                    title={whyUndeletable(profile) ?? "Forget this profile. Its cookies stay on disk."}
                    className="text-destructive hover:text-destructive"
                    onClick={() => void act(profile.id, () => bridge.deleteProfile!(profile.id))}
                  >
                    Delete
                  </Button>
                )}
              </div>
            }
          >
            {renaming === profile.id && (
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const label = String(new FormData(event.currentTarget).get("label") ?? "");
                  const problem = profileNameProblem(label, profiles ?? [], profile.id);
                  if (problem) {
                    setError(problem);
                    return;
                  }
                  setRenaming(undefined);
                  void act(profile.id, () => bridge.updateProfile({ profileId: profile.id, label: label.trim() }));
                }}
              >
                <Input name="label" defaultValue={profile.label} aria-label={`Rename ${profile.label}`} className="h-8 max-w-56" />
                <Button type="submit" size="sm" variant="secondary">
                  Save
                </Button>
              </form>
            )}
          </Row>
        ))}
      </SettingsGroup>
      <NewBrowserProfileDialog
        open={creating}
        onOpenChange={setCreating}
        existing={profiles ?? []}
        onCreated={() => void load()}
      />
    </>
  );
}
