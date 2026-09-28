"use client";

import { Suspense, useRef } from "react";
import dynamic from "next/dynamic";
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, EllipsisIcon, LockIcon, LockOpenIcon, MonitorSmartphoneIcon, MoonIcon, PencilIcon, RotateCwIcon, RotateCwSquareIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { siteLabel } from "../desktop-site-permissions";
import { useNativeViewOverlay } from "@/lib/native-view-overlay";
import { IdentityIcon } from "@/lib/telar-icons";
import { cn } from "@/lib/utils";
import { browserView, useBrowserActions, useBrowserCapture, useBrowserKeys, useBrowserPermissions, useBrowserSync, useDeviceSize, type BrowserProps, type BrowserUi } from "../hooks/use-browser-session";
import { useBrowserStore, type BrowserOverlay } from "../hooks/use-browser-store";
import { useHostSize } from "../hooks/use-browser-viewport";
import { useFrozenOverlay } from "../hooks/use-frozen-overlay";
import { addressValue, presentationZoomLabel } from "../model";
import type { DesktopBrowserTab } from "../types";
import { describeViewport, groupedViewportPresets, stageOf, viewportPreset, VIEWPORT_ZOOMS, zoomFits } from "../viewport";
import { CameraButton, CheckRow, Divider, ExtensionButton, menuRow, Notices } from "./browser-chrome";
import { OptionsMenu, ProfileMenu } from "./browser-menus";
import { DeviceFrame } from "./device-frame";
import { SitePermissionPrompt, SitePermissionsPopover, SiteSecurityIcon } from "./permission-prompt";
import { BrowserStartPage } from "./start-page";
import { TabStrip } from "./tab-strip";

const BrowserAnnotateOverlay = dynamic(() => import("./annotate-overlay").then((mod) => mod.BrowserAnnotateOverlay));

const GLYPH = "rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground";
const MENU_TRIGGER = "flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground";
const PILL_TRIGGER = "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground";
const SIZE_FIELD = "h-6 w-14 rounded-md border border-border bg-background px-1.5 text-center font-mono text-2xs outline-none focus:border-ring";

/** Opens `key` or closes whichever menu is open, for a Popover's `onOpenChange`. */
const toggle = (b: BrowserUi, key: BrowserOverlay) => (open: boolean) => (open ? b.setOpenOverlay(key) : b.closeOverlay());

// Re-opening from the lock brings a waved-away question back; Esc keeps the question and puts the page back.
function SiteLock({ b, openOverlay }: { b: BrowserUi; openOverlay: BrowserOverlay }) {
  const { activeOrigin, activePrompt, tabPrompt, sitePermissions, permissionBusy } = b;
  if (!(activeOrigin || activePrompt) || !b.bridge.sitePermissions) return null;
  return (
    <Popover
      open={openOverlay === "site" || Boolean(activePrompt)}
      onOpenChange={(open) => {
        if (open) {
          b.setDismissedPrompts([]);
          b.setOpenOverlay("site");
          return;
        }
        if (activePrompt) b.setDismissedPrompts((current) => [...current, activePrompt.requestId]);
        b.closeOverlay();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={activePrompt ? `${siteLabel(activePrompt.origin)} is asking for permission` : activeOrigin ? `Site permissions for ${siteLabel(activeOrigin)}` : "Site permissions"}
            title={activePrompt ? "This page is asking for permission" : "What this site is allowed to do"}
            className={cn(
              "relative shrink-0 rounded-md p-0.5 hover:bg-muted",
              tabPrompt ? "text-primary" : sitePermissions.some((record) => record.decision === "allow") ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <SiteSecurityIcon origin={activeOrigin} />
        {tabPrompt && !activePrompt ? <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" /> : null}
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={6} aria-label={activePrompt ? "Site permission request" : "Site permissions"} className="w-72">
        {activePrompt ? (
          <SitePermissionPrompt prompt={activePrompt} busy={permissionBusy} onAnswer={(answer) => void b.answerPermission(activePrompt.requestId, answer)} />
        ) : (
          <SitePermissionsPopover origin={activeOrigin} records={sitePermissions} busy={permissionBusy} onForget={(kind) => void b.forgetPermission(kind)} onReset={() => void b.forgetPermission()} />
        )}
      </PopoverContent>
    </Popover>
  );
}

// The address is what this row is for; everything else on it is a glyph (see ADDRESS_CONTROLS).
type AddressRowProps = { b: BrowserUi; openOverlay: BrowserOverlay; addressRowRef: React.RefObject<HTMLFormElement | null>; keyButtonRef: React.RefObject<HTMLButtonElement | null> };

function AddressRow({ b, openOverlay, addressRowRef, keyButtonRef }: AddressRowProps) {
  const { activeTab, state, act, annotating } = b;
  const profile = state?.profile;
  return (
    <form
      ref={addressRowRef}
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = (b.draft ?? addressValue(activeTab?.url)).trim();
        if (!next) return;
        b.setDraft(undefined);
        void act({ action: (state?.tabs.length ?? 0) > 0 ? "navigate" : "new", url: next });
      }}
    >
      <button type="button" aria-label="Go back" disabled={!activeTab?.canGoBack} className={cn(GLYPH, "disabled:opacity-40")} onClick={() => void act({ action: "back" })}>
        <ArrowLeftIcon className="size-3.5" />
      </button>
      <button type="button" aria-label="Go forward" disabled={!activeTab?.canGoForward} className={cn(GLYPH, "disabled:opacity-40")} onClick={() => void act({ action: "forward" })}>
        <ArrowRightIcon className="size-3.5" />
      </button>
      <button type="button" aria-label="Reload" className={GLYPH} onClick={() => void act({ action: "reload" })}>
        <RotateCwIcon className={cn("size-3.5", activeTab?.loading && "animate-spin text-primary")} />
      </button>
      <SiteLock b={b} openOverlay={openOverlay} />
      <input
        aria-label="Address"
        placeholder="Type an address"
        spellCheck={false}
        className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-2xs outline-none focus:border-ring"
        value={b.draft ?? addressValue(activeTab?.url)}
        onChange={(event) => {
          b.setDraft(event.target.value);
          b.signalIntent();
        }}
        onBlur={() => b.setDraft(undefined)}
      />
      {profile && b.bridge.setScopeProfile ? (
        <Popover open={openOverlay === "profile"} onOpenChange={toggle(b, "profile")}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={`Browser profile: ${profile.label}${profile.account ? ` (${profile.account})` : ""}`}
                title={`Browser profile ${profile.label}${profile.account ? ` · expected account ${profile.account}` : ""}\nNew tabs open signed in as this profile.`}
                className={MENU_TRIGGER}
              >
                <IdentityIcon icon={profile.icon} color={profile.color} className="size-3.5 shrink-0" />
              </button>
            }
          />
          <PopoverContent align="end" side="bottom" sideOffset={6} aria-label="Browser profile" className="w-64 gap-0 p-1">
            <ProfileMenu b={b} profile={profile} />
          </PopoverContent>
        </Popover>
      ) : null}
      <ExtensionButton b={b} keyButtonRef={keyButtonRef} />
      {b.rowFitsTools && b.canCapture ? (
        <>
          <CameraButton busy={b.capturing} onCapture={(fullPage) => void b.captureInto(fullPage ? { fullPage: true } : {})} />
          <button
            type="button"
            aria-label="Annotate this page"
            aria-pressed={Boolean(annotating)}
            title="Freeze the page and mark it up, then send it to the agent."
            disabled={b.capturing}
            onClick={() => (annotating ? b.setAnnotating(undefined) : void b.startAnnotate())}
            className={cn("shrink-0", GLYPH, "disabled:opacity-40", annotating && "bg-muted text-foreground")}
          >
            <PencilIcon className="size-3.5" />
          </button>
        </>
      ) : null}
      <Popover open={openOverlay === "options"} onOpenChange={toggle(b, "options")}>
        <PopoverTrigger
          render={
            <button type="button" aria-label="Browser options" title="Browser options" className={MENU_TRIGGER}>
              <EllipsisIcon className="size-3.5 shrink-0" />
            </button>
          }
        />
        <PopoverContent align="end" side="bottom" sideOffset={6} aria-label="Browser options" className="w-64 gap-0 p-1">
          <OptionsMenu b={b} />
        </PopoverContent>
      </Popover>
    </form>
  );
}

// Returns the two popovers rather than rendering them, so the toolbar can place them apart.
function deviceMenus({ b, openOverlay, index, viewport }: { b: BrowserUi; openOverlay: BrowserOverlay; index: number; viewport: NonNullable<DesktopBrowserTab["viewport"]> }) {
  const pick = (action: Record<string, unknown>) => {
    b.closeOverlay();
    void b.act({ action: "resize", index, ...action });
  };
  const current = viewportPreset(viewport.preset)?.key;
  const zoom = b.state?.presentation?.zoom ?? "fit";
  return {
    device: (
      <Popover open={openOverlay === "device"} onOpenChange={toggle(b, "device")}>
        <PopoverTrigger
          render={
            <button type="button" aria-label={`Device: ${describeViewport(viewport, "fixed")}`} className={cn(PILL_TRIGGER, "text-2xs")}>
              <span>{viewportPreset(viewport.preset)?.label ?? "Custom"}</span>
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 rotate-90" />
            </button>
          }
        />
        <PopoverContent align="start" side="bottom" sideOffset={6} aria-label="Device preset" className="max-h-(--available-height) w-60 gap-0 overflow-y-auto p-1">
          <button type="button" onClick={() => pick({ mode: "fit" })} className={cn(menuRow, "pl-9")}>
            <span className="min-w-0 flex-1">Fit to panel</span>
          </button>
          {groupedViewportPresets().map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <Divider />
              <p aria-hidden className="px-2 pt-1 pb-0.5 text-3xs font-medium text-muted-foreground">{group.label}</p>
              {group.presets.map((preset) => (
                <CheckRow key={preset.key} on={current === preset.key} onClick={() => pick({ preset: preset.key })}>
                  <span className="min-w-0 flex-1">{preset.label}</span>
                  <span className="shrink-0 font-mono text-3xs text-muted-foreground">{preset.width}×{preset.height}</span>
                </CheckRow>
              ))}
            </div>
          ))}
        </PopoverContent>
      </Popover>
    ),
    zoom: (
      <Popover open={openOverlay === "zoom"} onOpenChange={toggle(b, "zoom")}>
        <PopoverTrigger
          render={
            <button type="button" aria-label={`Presentation zoom: ${presentationZoomLabel(b.state?.presentation)}`} title="How big the panel shows the page" className={cn("ml-auto", PILL_TRIGGER, "font-mono text-3xs")}>
              <span>{presentationZoomLabel(b.state?.presentation)}</span>
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 rotate-90" />
            </button>
          }
        />
        <PopoverContent align="end" side="bottom" sideOffset={6} aria-label="Presentation zoom" className="w-36 gap-0 p-1">
          {VIEWPORT_ZOOMS.map((entry) => {
            // A zoom the page would not fit at is offered but disabled: the native view cannot scroll past the stage.
            const fits = !b.hostSize || zoomFits(entry.key, viewport, stageOf(b.hostSize));
            return (
              <CheckRow key={entry.label} on={zoom === entry.key} disabled={!fits} {...(fits ? {} : { title: "The page does not fit the panel at this size" })} onClick={() => pick({ zoom: entry.key })}>
                <span className="min-w-0 flex-1">{entry.label}</span>
              </CheckRow>
            );
          })}
        </PopoverContent>
      </Popover>
    ),
  };
}

// A row, not a portal: it changes the layout, so the native view is pushed down rather than covered.
function DeviceToolbar({ b, openOverlay }: { b: BrowserUi; openOverlay: BrowserOverlay }) {
  const { activeTab, draftSize, lockRatio } = b;
  const viewport = activeTab?.viewport;
  if (!b.deviceToolbar || !activeTab || !viewport) return null;
  const menus = deviceMenus({ b, openOverlay, index: activeTab.index, viewport });
  const field = (key: "width" | "height") => (
    <input
      aria-label={`Viewport ${key}`}
      inputMode="numeric"
      value={draftSize?.[key] ?? String(viewport[key])}
      onChange={(event) => b.setSizeDraft({ tabId: activeTab.id, width: draftSize?.width ?? String(viewport.width), height: draftSize?.height ?? String(viewport.height), [key]: event.target.value })}
      // Portal events bubble through the React tree; the panel's chords must not read this.
      onKeyDown={(event) => { event.stopPropagation(); b.stepSize(key, event); }}
      title="↑/↓ steps 1, with Shift 10"
      onBlur={b.commitSize}
      className={SIZE_FIELD}
    />
  );
  const fit = () => { b.setSizeDraft(undefined); void b.act({ action: "resize", index: activeTab.index, mode: "fit" }); };
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1" aria-label="Device toolbar">
      <MonitorSmartphoneIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {menus.device}
      <form className="flex shrink-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); b.commitSize(); }}>
        {field("width")}
        <span aria-hidden className="text-3xs text-muted-foreground">×</span>
        {field("height")}
      </form>
      <button
        type="button"
        aria-label={lockRatio ? "Unlock the aspect ratio" : "Lock the aspect ratio"}
        aria-pressed={lockRatio}
        title="Keep the width and height in proportion while resizing"
        onClick={() => b.setLockRatio((locked) => !locked)}
        className={cn("shrink-0 rounded-md p-1 hover:bg-muted hover:text-foreground", lockRatio ? "text-foreground" : "text-muted-foreground")}
      >
        {lockRatio ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Rotate the viewport"
        title="Swap width and height"
        onClick={() => { b.setSizeDraft(undefined); void b.act({ action: "resize", index: activeTab.index, width: viewport.height, height: viewport.width }); }}
        className={cn("shrink-0", GLYPH)}
      >
        <RotateCwSquareIcon className="size-3.5" />
      </button>
      {menus.zoom}
      <button type="button" aria-label="Close the device toolbar" title="Follow the panel again" onClick={fit} className={cn("shrink-0", GLYPH)}>
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

// The native view is glued to this element. Fit fills the panel and wears its corner; a fixed viewport keeps a card with rails.
function BrowserHost({ b, frozenFrame, hostRef }: { b: BrowserUi; frozenFrame: ReturnType<typeof useFrozenOverlay>; hostRef: React.RefObject<HTMLDivElement | null> }) {
  const { activeTab, state, viewportMode, annotating, onAttach, act } = b;
  const blank = activeTab ? addressValue(activeTab.url) === "" : false;
  const page = activeTab && !blank && !activeTab.sleeping && !activeTab.preview;
  return (
    <div
      ref={hostRef}
      className={cn("relative min-h-0 flex-1 bg-muted/20 md:overflow-hidden", viewportMode === "fixed" ? "md:mx-2 md:mb-2 md:rounded-lg" : "md:rounded-b-xl")}
      aria-label="Live browser viewport"
      aria-busy={activeTab?.loading || undefined}
    >
      {frozenFrame && (
        <img
          aria-hidden
          alt=""
          draggable={false}
          src={frozenFrame.src}
          className="pointer-events-none absolute select-none"
          style={{ left: frozenFrame.left, top: frozenFrame.top, width: frozenFrame.width, height: frozenFrame.height }}
        />
      )}
      {viewportMode === "fixed" && activeTab?.viewport && page && b.hostSize ? (
        <DeviceFrame
          viewport={activeTab.viewport}
          mode={viewportMode}
          hostSize={b.hostSize}
          zoom={state?.presentation?.zoom ?? "fit"}
          lockRatio={b.lockRatio}
          preview={b.dragPreview}
          onPreview={b.setDragPreview}
          onLive={b.liveResize}
          onCommit={(size) => void act({ action: "resize", index: activeTab.index, width: size.width, height: size.height })}
          railsKey={`${b.scopeKey}:${activeTab.id}`}
        />
      ) : null}
      {activeTab?.loading && <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary/70" />}
      {activeTab?.sleeping && (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          <MoonIcon className="mr-1.5 size-3.5" /> Remembered page — loading…
        </div>
      )}
      {activeTab?.preview && (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <SquareArrowOutUpRightIcon aria-hidden className="size-4" />
          <p>This tab is open in a window of its own.</p>
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => void act({ action: "end-preview" })}>
            Bring it back
          </Button>
        </div>
      )}
      {annotating && onAttach ? (
        // The overlay is its own chunk: its first fetch must suspend here, not at the route.
        <Suspense fallback={null}>
          <BrowserAnnotateOverlay
            key={`${annotating.url}:${annotating.width}x${annotating.height}`}
            capture={annotating}
            onCancel={() => b.setAnnotating(undefined)}
            onSend={({ file, text }) => {
              onAttach([file], text);
              b.setAnnotating(undefined);
            }}
          />
        </Suspense>
      ) : null}
      {b.bound && state && (state.tabs.length === 0 || (activeTab && !activeTab.sleeping && !activeTab.preview && blank && !activeTab.loading)) && (
        <BrowserStartPage scopeKey={b.scopeKey} onOpen={(url) => void act(activeTab && blank ? { action: "navigate", url } : { action: "new", url })} />
      )}
    </div>
  );
}

/** The desktop shell's native browser glued under the panel, with its tab strip, address row and tools. */
export function DesktopBrowserSurface(props: BrowserProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRowRef = useRef<HTMLFormElement>(null);
  const keyButtonRef = useRef<HTMLButtonElement>(null);
  const partitionRef = useRef<string | undefined>(undefined);
  const intentAtRef = useRef(0);
  const overlayRef = useRef(false);
  const s = useBrowserStore(props.scopeKey, props.projectId, addressRowRef, partitionRef);
  const { openOverlay, annotating } = s;
  useNativeViewOverlay(openOverlay !== null);
  useNativeViewOverlay(Boolean(annotating));
  const view = browserView(s);
  const { activePrompt } = view;
  useNativeViewOverlay(Boolean(activePrompt));
  const hostSize = useHostSize(hostRef);
  const frozenFrame = useFrozenOverlay(props.bridge, props.scopeKey, hostRef, overlayRef);
  const sync = useBrowserSync(props, s, view, { intentAtRef, partitionRef, hostRef, overlayRef });
  const actions = useBrowserActions(props, s, sync, keyButtonRef);
  const permissions = useBrowserPermissions(props, s, view);
  const capture = useBrowserCapture(props, s, view);
  const size = useDeviceSize(props, s, view, actions.act);
  const onKeys = useBrowserKeys(s, view, actions.act);
  const b: BrowserUi = { ...props, ...s, ...view, ...sync, ...actions, ...permissions, ...capture, ...size, hostSize };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={onKeys}
      // focusin/focusout: a move between two controls inside is not a release.
      onFocus={() => s.setChromeHasKeys(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) s.setChromeHasKeys(false);
      }}
    >
      <TabStrip b={b} />
      <AddressRow b={b} openOverlay={openOverlay} addressRowRef={addressRowRef} keyButtonRef={keyButtonRef} />
      <DeviceToolbar b={b} openOverlay={openOverlay} />
      <Notices b={b} />
      <BrowserHost b={b} frozenFrame={frozenFrame} hostRef={hostRef} />
    </div>
  );
}
