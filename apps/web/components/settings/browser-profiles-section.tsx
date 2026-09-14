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
import { MonitorIcon } from "lucide-react";
import {
  desktopBrowserProfiles,
  describeProfileUse,
  profileNameProblem,
  whyUndeletable,
  type BrowserProfile,
} from "@/lib/desktop-browser-profiles";
import {
  desktopSitePermissions,
  describeSitePermission,
  siteLabel,
  type SitePermissionKind,
  type SitePermissionProfile,
} from "@/lib/desktop-site-permissions";
import { PermissionKindIcon } from "@/components/browser-permission-prompt";
import { NewBrowserProfileDialog } from "@/components/browser-profile-prompt";
import { IdentityIcon } from "@/lib/telar-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ProfileColorPicker, ProfileIconPicker } from "./browser-profile-marks";
import { Row, SettingsGroup } from "./settings-shell";

/** `Row` takes a component and a mark is data; this binds the two so the row
 *  grammar never has to learn what an identity glyph is. */
function profileGlyph(profile: BrowserProfile) {
  return function ProfileGlyph({ className }: { className?: string }) {
    return <IdentityIcon icon={profile.icon} color={profile.color} className={className} />;
  };
}

export function BrowserProfilesSection() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>();
  /**
   * WHY THE LAST WRITE DID NOT LAND, AND TO WHICH ROW IT BELONGS (#430). A
   * single line at the top of the group is a line the reader may never see:
   * this list runs to eight rows on an upgraded machine, and a refusal from
   * the bottom one scrolls off the top. `at` pins the sentence to the row that
   * was refused; only a failure with no row (the initial read) stays up top.
   */
  const [error, setError] = useState<{ message: string; at?: string }>();
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
      setError({ message: "The desktop shell did not answer; its browser host may still be starting." });
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /** Every write lands the shell's own answer, because the shell is what
   *  validates: a refusal must show up as the refusal, not as a row that moved.
   *  The shell knows things this pane cannot — which sessions have tabs open in
   *  a profile — so a Delete that looked available still comes back refused,
   *  and that sentence is the only explanation there is. */
  const act = async (id: string, write: () => Promise<{ profiles: BrowserProfile[] }>) => {
    setBusy(id);
    setError(undefined);
    try {
      setProfiles((await write()).profiles);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "That change could not be made.";
      /**
       * THE RE-READ FIRST, THE SENTENCE AFTER IT — the other half of the silent
       * Delete (#430). `load` clears the error line on success, so setting the
       * refusal before re-reading wiped it a turn later: the row snapped back to
       * exactly what it said before the press, with nothing anywhere saying why.
       */
      await load();
      setError({ message, at: id });
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
        {error && !error.at && (
          <p role="alert" className="text-xs text-destructive">
            {error.message}
          </p>
        )}
        {profiles === undefined && !error && <Spinner className="size-4" />}
        {profiles?.map((profile) => (
          <Row
            key={profile.id}
            {...(error?.at === profile.id ? { error: error.message } : {})}
            /* THE ROW'S OWN GLYPH IS THE PROFILE'S. An unmarked profile keeps
               the neutral ring rather than a generic person icon — the slot has
               to read as "nothing chosen here", because choosing is what the
               picker beside it is for. */
            icon={profileGlyph(profile)}
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
                {/* THE MARKS COME FIRST, before the verbs. They are properties
                    of the profile the way its name is — the buttons beside them
                    are things you DO to it, and mixing the two orders made the
                    row read as five equal actions. */}
                <ProfileIconPicker
                  profile={profile.label}
                  {...(profile.icon ? { icon: profile.icon } : {})}
                  disabled={busy === profile.id}
                  onPick={(icon) => void act(profile.id, () => bridge.updateProfile({ profileId: profile.id, icon }))}
                />
                <ProfileColorPicker
                  profile={profile.label}
                  {...(profile.color ? { color: profile.color } : {})}
                  disabled={busy === profile.id}
                  onPick={(color) => void act(profile.id, () => bridge.updateProfile({ profileId: profile.id, color }))}
                />
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
                    {...(whyUndeletable(profile) ? { "aria-describedby": `profile-undeletable-${profile.id}` } : {})}
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
            {/* WHY DELETE IS GREY, ON THE ROW (#430). A `title` is a tooltip:
                it needs a mouse, it needs a hover, and it is never read by
                someone scanning a list of eight rows wondering why none of
                them can be deleted. The sentence's second half is the way out
                — make another profile the default, point that project
                elsewhere — so it is the half that has to be on screen. */}
            {bridge.deleteProfile && whyUndeletable(profile) && (
              <p id={`profile-undeletable-${profile.id}`} className="mt-1 text-xs leading-snug text-muted-foreground/80">
                {whyUndeletable(profile)}
              </p>
            )}
            {renaming === profile.id && (
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const label = String(new FormData(event.currentTarget).get("label") ?? "");
                  const problem = profileNameProblem(label, profiles ?? [], profile.id);
                  if (problem) {
                    setError({ message: problem, at: profile.id });
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
      <SitePermissionsGroup />
      <NewBrowserProfileDialog
        open={creating}
        onOpenChange={setCreating}
        existing={profiles ?? []}
        onCreated={() => void load()}
      />
    </>
  );
}

/**
 * SITE PERMISSIONS — every answer this install has given a site, by profile, and
 * the one button that takes one back.
 *
 * WHY IT IS HERE AND NOT ONLY UNDER THE LOCK ICON. The lock answers "what does
 * THIS page hold", which is the question you have while looking at that page.
 * The question this pane answers is the other one — "what have I agreed to" —
 * and it cannot be asked from inside any single session, because the answers are
 * scattered across as many profiles as this install has.
 *
 * READ AND REVOKE ONLY, like remembered logins below it. A permission is created
 * in exactly one way: by answering a prompt with the page in front of you. A
 * settings screen that could mint one would be a settings screen handing out a
 * camera at a distance.
 */
export function SitePermissionsGroup() {
  const [profiles, setProfiles] = useState<SitePermissionProfile[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const bridge = desktopSitePermissions();
  const supported = Boolean(bridge?.sitePermissions && bridge?.forgetSitePermission);

  const load = useCallback(async () => {
    const reader = desktopSitePermissions();
    if (!reader?.sitePermissions) return;
    try {
      const answer = await reader.sitePermissions({});
      setProfiles("profiles" in answer ? answer.profiles : []);
      setError(undefined);
    } catch {
      setError("The desktop shell did not answer; its browser host may still be starting.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /** Every write lands the shell's own answer — a refusal has to show up as the
   *  refusal, not as a row that moved. */
  const forget = async (key: string, input: { partition: string; origin: string; kind?: SitePermissionKind }) => {
    if (!bridge?.forgetSitePermission) return;
    setBusy(key);
    setError(undefined);
    try {
      setProfiles((await bridge.forgetSitePermission(input)).profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That permission could not be forgotten.");
      await load();
    } finally {
      setBusy(undefined);
    }
  };

  if (!supported) {
    return (
      <SettingsGroup title="Site permissions" description="What sites may do in Telar's own browser.">
        <Row icon={MonitorIcon} label="Desktop app only" hint="This browser tab has no browser host to keep site permissions for." />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Site permissions"
      description="Camera, microphone, notifications, location, clipboard and screen sharing, as you answered them."
    >
      {error && <p className="text-xs text-destructive">{error}</p>}
      {profiles === undefined && !error && <Spinner className="size-4" />}
      {/* A row rather than a loose paragraph, so the empty state sits on the
          same grid as the list it replaces. */}
      {profiles?.length === 0 && (
        <Row label="Nothing decided yet" hint="Telar asks the first time a site wants something, over the browser's address bar." />
      )}
      {profiles?.map((profile) =>
        profile.origins.map((site) => (
          <Row
            key={`${profile.partition}:${site.origin}`}
            id={`settings-row-site-permission-${profile.partition}-${site.origin}`}
            label={<span className="truncate font-mono text-[0.75rem]">{siteLabel(site.origin)}</span>}
            /* THE PROFILE IS THE HALF THAT CANNOT BE LEFT OUT: the same site can
               be allowed in one identity and blocked in another, and a list that
               did not say which would be a list you cannot act on. */
            hint={`${profile.label} · ${site.kinds.map(describeSitePermission).join(", ")}`}
            control={
              <div className="flex items-center gap-1">
                {site.kinds.map((record) => (
                  <button
                    key={record.kind}
                    type="button"
                    disabled={busy === `${profile.partition}:${site.origin}`}
                    aria-label={`Forget ${describeSitePermission(record)} for ${siteLabel(site.origin)} in ${profile.label}`}
                    title={`${describeSitePermission(record)} — forget this answer. The site asks again next time.`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    onClick={() =>
                      void forget(`${profile.partition}:${site.origin}`, { partition: profile.partition, origin: site.origin, kind: record.kind })
                    }
                  >
                    <PermissionKindIcon kind={record.kind} className={record.decision === "block" ? "opacity-50" : undefined} />
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === `${profile.partition}:${site.origin}`}
                  title={`Forget every answer given to ${siteLabel(site.origin)} in ${profile.label}. Nothing is signed out; the site asks again next time.`}
                  className="text-destructive hover:text-destructive"
                  onClick={() => void forget(`${profile.partition}:${site.origin}`, { partition: profile.partition, origin: site.origin })}
                >
                  Remove
                </Button>
              </div>
            }
          />
        )),
      )}
    </SettingsGroup>
  );
}
