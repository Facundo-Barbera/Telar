"use client";

import { useCallback, useEffect, useState } from "react";
import { MonitorIcon } from "lucide-react";
import {
  confirmProfileDeletion,
  desktopBrowserProfiles,
  describeProfileUse,
  profileNameProblem,
  whyUndeletable,
  type BrowserProfile,
} from "../desktop-browser-profiles";
import {
  desktopSitePermissions,
  describeSitePermission,
  siteLabel,
  type SitePermissionKind,
  type SitePermissionProfile,
} from "../desktop-site-permissions";
import { NewBrowserProfileDialog, PermissionKindIcon } from "../settings";
import { IdentityIcon } from "@/ui/telar-icons";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { ProfileColorPicker, ProfileIconPicker } from "./browser-profile-marks";
import { Row, SettingsGroup } from "@/features/settings";

function profileGlyph(profile: BrowserProfile) {
  return function ProfileGlyph({ className }: { className?: string }) {
    return <IdentityIcon icon={profile.icon} color={profile.color} className={className} />;
  };
}

type ProfilesBridge = NonNullable<ReturnType<typeof desktopBrowserProfiles>>;

function ProfileRow({
  profile,
  profiles,
  bridge,
  busy,
  error,
  renaming,
  onRenaming,
  onError,
  act,
}: {
  profile: BrowserProfile;
  profiles: BrowserProfile[];
  bridge: ProfilesBridge;
  busy: boolean;
  error: string | undefined;
  renaming: boolean;
  onRenaming: (next: boolean) => void;
  onError: (message: string) => void;
  act: (write: () => Promise<{ profiles: BrowserProfile[] }>) => void;
}) {
  return (

    <Row
      {...(error ? { error } : {})}
      icon={profileGlyph(profile)}
      label={
        <span className="flex items-center gap-2">
          <span className="truncate">{profile.label}</span>
          {profile.isDefault && profile.label.trim().toLowerCase() !== "default" && <Badge variant="secondary">Default</Badge>}
          {profile.account && <span className="truncate font-mono text-3xs text-muted-foreground">{profile.account}</span>}
        </span>
      }
      hint={describeProfileUse(profile)}
      control={
        <div className="flex items-center gap-1">
          <ProfileIconPicker
            profile={profile.label}
            {...(profile.icon ? { icon: profile.icon } : {})}
            disabled={busy}
            onPick={(icon) => act(() => bridge.updateProfile({ profileId: profile.id, icon }))}
          />
          <ProfileColorPicker
            profile={profile.label}
            {...(profile.color ? { color: profile.color } : {})}
            disabled={busy}
            onPick={(color) => act(() => bridge.updateProfile({ profileId: profile.id, color }))}
          />
          {!profile.isDefault && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Every project that has not picked a profile browses here from now on. Projects already assigned somewhere are not moved."
              onClick={() => act(() => bridge.setDefaultProfile(profile.id))}
            >
              Make default
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onRenaming(!renaming)}>
            {renaming ? "Done" : "Rename"}
          </Button>
          {bridge.deleteProfile && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || Boolean(whyUndeletable(profile))}
              {...(whyUndeletable(profile) ? { "aria-describedby": `profile-undeletable-${profile.id}` } : {})}
              title={whyUndeletable(profile) ?? "Forget this profile. Its cookies stay on disk."}
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (!window.confirm(confirmProfileDeletion(profile, profiles))) return;
                act(() => bridge.deleteProfile!(profile.id));
              }}
            >
              Delete
            </Button>
          )}
        </div>
      }
    >
      {bridge.deleteProfile && whyUndeletable(profile) && (
        <p id={`profile-undeletable-${profile.id}`} className="mt-1 text-xs leading-snug text-muted-foreground/80">
          {whyUndeletable(profile)}
        </p>
      )}
      {renaming && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const label = String(new FormData(event.currentTarget).get("label") ?? "");
            const problem = profileNameProblem(label, profiles, profile.id);
            if (problem) {
              onError(problem);
              return;
            }
            onRenaming(false);
            act(() => bridge.updateProfile({ profileId: profile.id, label: label.trim() }));
          }}
        >
          <Input name="label" defaultValue={profile.label} aria-label={`Rename ${profile.label}`} className="h-8 max-w-56" />
          <Button type="submit" size="sm" variant="secondary">
            Save
          </Button>
        </form>
      )}
    </Row>
  );
}

export function BrowserProfilesSection() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>();
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

  const act = async (id: string, write: () => Promise<{ profiles: BrowserProfile[] }>) => {
    setBusy(id);
    setError(undefined);
    try {
      setProfiles((await write()).profiles);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "That change could not be made.";
      await load();
      setError({ message, at: id });
    } finally {
      setBusy(undefined);
    }
  };

  if (!bridge) {
    return (
      <SettingsGroup title="Browser profiles" scope="mac" description="The identities Telar's own browser signs in as.">
        <Row icon={MonitorIcon} label="Desktop app only" hint="This browser tab has no browser host to keep profiles for." />
      </SettingsGroup>
    );
  }

  return (
    <>
      <SettingsGroup
        title="Browser profiles"
        scope="mac"
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
          <ProfileRow
            key={profile.id}
            profile={profile}
            profiles={profiles}
            bridge={bridge}
            busy={busy === profile.id}
            error={error?.at === profile.id ? error.message : undefined}
            renaming={renaming === profile.id}
            onRenaming={(next) => setRenaming(next ? profile.id : undefined)}
            onError={(message) => setError({ message, at: profile.id })}
            act={(write) => void act(profile.id, write)}
          />
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

function SitePermissionsGroup() {
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
      <SettingsGroup title="Site permissions" scope="mac" description="What sites may do in Telar's own browser.">
        <Row icon={MonitorIcon} label="Desktop app only" hint="This browser tab has no browser host to keep site permissions for." />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Site permissions"
      scope="mac"
      description="Camera, microphone, notifications, location, clipboard and screen sharing, as you answered them."
    >
      {error && <p className="text-xs text-destructive">{error}</p>}
      {profiles === undefined && !error && <Spinner className="size-4" />}
      {profiles?.length === 0 && (
        <Row label="Nothing decided yet" hint="Telar asks the first time a site wants something, over the browser's address bar." />
      )}
      {profiles?.map((profile) =>
        profile.origins.map((site) => (
          <Row
            key={`${profile.partition}:${site.origin}`}
            id={`settings-row-site-permission-${profile.partition}-${site.origin}`}
            label={<span className="truncate font-mono text-[0.75rem]">{siteLabel(site.origin)}</span>}
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
