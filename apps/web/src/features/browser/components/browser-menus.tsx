"use client";

import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, MinusIcon, PencilIcon, PlusIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { siteLabel } from "../desktop-site-permissions";
import { IdentityIcon } from "@/ui/telar-icons";
import { cn } from "@/ui/utils";
import type { BrowserUi } from "../hooks/use-browser-session";
import { APPEARANCES, zoomLabel } from "../model";
import type { DesktopBrowserProfile } from "../types";
import { CheckRow, Divider, menuRow } from "./browser-chrome";

const row = cn(menuRow, "pl-9");
const FIELD = "h-7 rounded-md border border-border bg-background px-2 outline-none focus:border-ring";

function FormFooter({ b, submit, disabled }: { b: BrowserUi; submit: string; disabled?: boolean }) {
  return (
    <div className="flex justify-end gap-1">
      <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => b.setProfilePane("menu")}>
        Cancel
      </Button>
      <Button type="submit" size="sm" variant="outline" className="h-6 px-2 text-2xs" {...(disabled === undefined ? {} : { disabled })}>
        {submit}
      </Button>
    </div>
  );
}

function RenameForm({ b, profile }: { b: BrowserUi; profile: DesktopBrowserProfile }) {
  return (
    <form
      className="flex flex-col gap-1.5 p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const label = new FormData(event.currentTarget).get("label");
        if (typeof label !== "string" || !label.trim()) return;
        b.closeOverlay();
        void b.profileAction(() => b.bridge.updateProfile!({ profileId: profile.id, label }));
      }}
    >
      <label htmlFor="telar-browser-profile-rename" className="text-2xs text-muted-foreground">Rename this profile</label>
      <input
        id="telar-browser-profile-rename"
        key={profile.id}
        name="label"
        autoFocus
        defaultValue={profile.label}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(FIELD, "text-[0.75rem]")}
      />
      <FormFooter b={b} submit="Rename" />
    </form>
  );
}

function NewProfileForm({ b }: { b: BrowserUi }) {
  const { newProfileLabel, newProfileAccount, setNewProfileLabel, setNewProfileAccount } = b;
  return (
    <form
      className="flex flex-col gap-1.5 p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!newProfileLabel.trim()) return;
        const label = newProfileLabel;
        const account = newProfileAccount.trim();
        setNewProfileLabel("");
        setNewProfileAccount("");
        b.closeOverlay();
        void b.profileAction(() => b.bridge.createProfile!({ label, ...(account ? { account } : {}), scopeKey: b.scopeKey }));
      }}
    >
      <label htmlFor="telar-browser-profile-new" className="text-2xs text-muted-foreground">New profile</label>
      <input
        id="telar-browser-profile-new"
        aria-label="New profile name"
        placeholder="Name"
        autoFocus
        value={newProfileLabel}
        onChange={(event) => setNewProfileLabel(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(FIELD, "text-[0.75rem]")}
      />
      <input
        aria-label="Expected account for the new profile"
        placeholder="account (optional)"
        value={newProfileAccount}
        onChange={(event) => setNewProfileAccount(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(FIELD, "font-mono text-2xs")}
      />
      <FormFooter b={b} submit="Add and use" disabled={!newProfileLabel.trim()} />
    </form>
  );
}

/** Who this scope browses as, every identity to switch to, and what can be done about it. */
export function ProfileMenu({ b, profile }: { b: BrowserUi; profile: DesktopBrowserProfile }) {
  const { bridge, scopeKey, state } = b;
  if (b.profilePane === "rename") return <RenameForm b={b} profile={profile} />;
  if (b.profilePane === "new") return <NewProfileForm b={b} />;
  const run = (write: () => Promise<unknown>) => {
    b.closeOverlay();
    void b.profileAction(write);
  };
  return (
    <>
      <div className="flex items-start gap-2 px-2 pt-1 pb-1.5">
        <IdentityIcon icon={profile.icon} color={profile.color} className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-[0.75rem] font-medium">{profile.label}</p>
          <p className="truncate font-mono text-3xs text-muted-foreground">{profile.account || "No expected account"}</p>
        </div>
      </div>
      <Divider />
      {(state?.profiles ?? []).map((entry) => (
        <CheckRow
          key={entry.id}
          on={entry.id === profile.id}
          title={[
            entry.account ? `Expected account ${entry.account}` : "No expected account set",
            entry.projects?.length ? `Used by ${entry.projects.length} project${entry.projects.length === 1 ? "" : "s"}` : "Not assigned to a project",
            entry.isDefault ? "The default for new projects" : "",
          ].filter(Boolean).join("\n")}
          onClick={() => run(() => bridge.setScopeProfile!(scopeKey, entry.id))}
        >
          <IdentityIcon icon={entry.icon} color={entry.color} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          {entry.isDefault && <span className="shrink-0 text-3xs text-muted-foreground">default</span>}
        </CheckRow>
      ))}
      <Divider />
      {bridge.assignProjectProfile && state?.profileKey && state.profileKey !== "none" && (
        <button type="button" title="Every session of this project opens in this profile from now on." onClick={() => run(() => bridge.assignProjectProfile!({ scopeKey, profileId: profile.id }))} className={row}>
          Use for this project
        </button>
      )}
      {bridge.setDefaultProfile && !profile.isDefault && (
        <button
          type="button"
          title="New projects with no browsing history of their own join this profile. Projects already signed in somewhere are not moved."
          onClick={() => run(() => bridge.setDefaultProfile!(profile.id))}
          className={row}
        >
          Make default
        </button>
      )}
      {bridge.offerLoginMemory && !b.extension?.off && (
        <button
          type="button"
          title={"Already signed in on this page? Let agents reuse that login here.\nOpens Telar's own window; you pick the 1Password item there."}
          onClick={() =>
            run(async () => {
              const result = await bridge.offerLoginMemory!(scopeKey);
              if (!result.ok && result.error) throw new Error(result.error);
            })
          }
          className={row}
        >
          Let agents use a login…
        </button>
      )}
      {bridge.updateProfile && (
        <button type="button" onClick={() => b.setProfilePane("rename")} className={row}>
          Rename…
        </button>
      )}
      {bridge.createProfile && (
        <button type="button" onClick={() => b.setProfilePane("new")} className={row}>
          New profile…
        </button>
      )}
      <p className="px-2 pt-1.5 pb-1 text-3xs leading-snug text-muted-foreground">
        Switching changes where the next tab opens. Tabs already open stay signed in as the profile they were opened with — an
        expected account is what you intend, not a verified login.
      </p>
    </>
  );
}

const ZOOM_STEP = "shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50";

function ZoomRow({ b }: { b: BrowserUi }) {
  const { activeTab, act } = b;
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <span className="min-w-0 flex-1 text-[0.75rem] text-muted-foreground">Zoom</span>
      <button type="button" aria-label="Zoom out" disabled={!activeTab} onClick={() => void act({ action: "zoom", direction: "out" })} className={ZOOM_STEP}>
        <MinusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Reset zoom to 100%. Currently ${zoomLabel(activeTab?.zoom)}.`}
        title="Reset to 100%"
        disabled={!activeTab}
        onClick={() => void act({ action: "zoom", direction: "reset" })}
        className="w-12 shrink-0 rounded-md py-1 text-center font-mono text-3xs text-foreground hover:bg-accent/60 disabled:opacity-50"
      >
        {zoomLabel(activeTab?.zoom)}
      </button>
      <button type="button" aria-label="Zoom in" disabled={!activeTab} onClick={() => void act({ action: "zoom", direction: "in" })} className={ZOOM_STEP}>
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

function OptionsRows({ b }: { b: BrowserUi }) {
  const { activeTab, state, bridge, capturing, canCapture, deviceToolbar } = b;
  const run = (then: () => void) => {
    b.closeOverlay();
    then();
  };
  return (
    <>
      {canCapture ? (
        <>
          <button type="button" disabled={capturing} onClick={() => run(() => void b.captureInto({}))} className={row}>
            <span className="min-w-0 flex-1">Screenshot the viewport</span>
            <CameraIcon aria-hidden className="size-3 shrink-0" />
          </button>
          <button type="button" disabled={capturing} onClick={() => run(() => void b.captureInto({ fullPage: true }))} className={row}>
            Screenshot the full page
          </button>
          <button type="button" disabled={capturing} onClick={() => run(() => void b.startAnnotate())} className={row}>
            <span className="min-w-0 flex-1">Annotate this page</span>
            <PencilIcon aria-hidden className="size-3 shrink-0" />
          </button>
          <Divider />
        </>
      ) : null}
      <button type="button" disabled={!activeTab} onClick={() => run(() => void b.act({ action: "hard-reload" }))} className={row}>
        Hard reload
      </button>
      <button type="button" disabled={!activeTab} onClick={() => run(() => void b.act({ action: "toggle-devtools" }))} className={row}>
        {activeTab?.devtools ? "Close DevTools" : "Open DevTools"}
      </button>
      <button
        type="button"
        disabled={!activeTab}
        title={activeTab?.preview ? "Put this tab back in the panel." : "Move this tab into a window of its own. The panel has nothing to show meanwhile — it is the same page, not a copy."}
        onClick={() => run(() => void b.act({ action: activeTab?.preview ? "end-preview" : "preview" }))}
        className={row}
      >
        <span className="min-w-0 flex-1">{activeTab?.preview ? "Bring back from separate window" : "Open separate preview window"}</span>
        {!activeTab?.preview && <SquareArrowOutUpRightIcon aria-hidden className="size-3 shrink-0" />}
      </button>
      <CheckRow
        on={deviceToolbar}
        disabled={!activeTab?.viewport}
        title="Lay the page out at a chosen size instead of following the panel."
        onClick={() => {
          if (activeTab) run(() => void b.act({ action: "resize", index: activeTab.index, mode: deviceToolbar ? "fit" : "fixed" }));
        }}
      >
        <span className="min-w-0 flex-1">Show device toolbar</span>
      </CheckRow>
      <button type="button" disabled={!activeTab} onClick={() => b.setOptionsPane("appearance")} className={row}>
        <span className="min-w-0 flex-1">Appearance</span>
        <span className="shrink-0 text-3xs text-muted-foreground">{APPEARANCES.find((entry) => entry.key === (activeTab?.colorScheme ?? "system"))?.label}</span>
        <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
      </button>
      <Divider />
      <ZoomRow b={b} />
      {state?.profile && bridge.setScopeProfile ? (
        <>
          <Divider />
          <button type="button" onClick={() => run(() => b.setOpenOverlay("profile"))} className={row}>
            <span className="min-w-0 flex-1 truncate">Profile: {state.profile.label}</span>
            <IdentityIcon icon={state.profile.icon} color={state.profile.color} className="size-3.5 shrink-0" />
          </button>
        </>
      ) : null}
      {bridge.clearBrowsingData && activeTab ? (
        <>
          <button type="button" onClick={() => b.setOptionsPane("cookies")} className={row}>
            Clear cookies…
          </button>
          <button type="button" onClick={() => b.setOptionsPane("cache")} className={row}>
            Clear cache…
          </button>
        </>
      ) : null}
    </>
  );
}

function AppearancePane({ b }: { b: BrowserUi }) {
  return (
    <>
      <button type="button" onClick={() => b.setOptionsPane("menu")} className={cn(menuRow, "text-foreground")}>
        <ChevronLeftIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">Appearance</span>
      </button>
      <Divider />
      {APPEARANCES.map((entry) => (
        <CheckRow
          key={entry.key}
          on={(b.activeTab?.colorScheme ?? "system") === entry.key}
          onClick={() => {
            b.closeOverlay();
            void b.act({ action: "appearance", scheme: entry.key });
          }}
        >
          <span className="min-w-0 flex-1">{entry.label}</span>
        </CheckRow>
      ))}
      <p className="px-2 pt-1.5 pb-1 text-3xs leading-snug text-muted-foreground">
        What this page is told to prefer. It changes nothing about Telar&apos;s own appearance.
      </p>
    </>
  );
}

// The shell clears the whole partition, so the sentence leads with the profile.
function ClearConfirm({ b, kind }: { b: BrowserUi; kind: "cookies" | "cache" }) {
  const profile = b.state?.profile?.label ?? "this profile";
  const site = b.activeOrigin ? siteLabel(b.activeOrigin) : "this page";
  const verb = kind === "cookies" ? "Clear cookies" : "Clear cache";
  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      <p className="text-[0.75rem] font-medium">
        {verb} for {profile}?
      </p>
      <p className="text-3xs leading-snug text-muted-foreground">
        {kind === "cookies"
          ? `This signs ${profile} out of every site it is signed into, ${site} included. Tabs already open stay open; they just stop being signed in.`
          : `This empties the cached files ${profile} holds for every site, ${site} included. Nothing is signed out.`}
      </p>
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => b.setOptionsPane("menu")}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={b.clearing}
          className="h-6 px-2 text-2xs"
          onClick={() => {
            b.closeOverlay();
            void b.clearData(kind);
          }}
        >
          {verb}
        </Button>
      </div>
    </div>
  );
}

/** The ⋯ menu's panes: its rows, the appearance submenu, or a clear confirm. */
export function OptionsMenu({ b }: { b: BrowserUi }) {
  if (b.optionsPane === "menu") return <OptionsRows b={b} />;
  if (b.optionsPane === "appearance") return <AppearancePane b={b} />;
  return <ClearConfirm b={b} kind={b.optionsPane} />;
}
