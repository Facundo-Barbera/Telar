"use client";

/**
 * THE PERMISSION PROMPT, AND THE LOCK POPOVER BEHIND IT — the two halves of
 * "this site would like to use your camera", drawn by Telar rather than by
 * Chromium (#422).
 *
 * WHY TELAR DRAWS IT. The pages live in a native `WebContentsView` glued under
 * this panel; Chromium's own permission bubble would be positioned against a
 * window that is not where the person is looking, in a chrome this app does not
 * have. So the shell asks over IPC and this renders the question where a browser
 * puts it: anchored to the address bar, under the lock icon that later shows what
 * was decided.
 *
 * THREE ANSWERS, AND THE MIDDLE ONE IS THE POINT. Allow is remembered, Block is
 * remembered (that is what the button means in every browser, and an origin you
 * refused should not ask again on every reload), and Allow once is written down
 * nowhere at all — it lives against the page that asked and dies with it.
 *
 * SCREEN SHARING ASKS A DIFFERENT QUESTION. Not "may I" but "which one", so its
 * prompt is the picker: the screens and windows the shell listed, with
 * thumbnails, and Share / Cancel. Cancelling is not a refusal of the site —
 * nothing is remembered either way — which is why it does not say Block.
 *
 * NOTHING HERE CALLS THE BRIDGE. The surface that owns the prompt (the browser
 * panel) does, because it also owns the native view that has to be out of the way
 * while any of this is on screen — see `lib/native-view-overlay.ts`.
 */

import { useState } from "react";
import { BellIcon, CameraIcon, ClipboardIcon, GlobeIcon, LockIcon, MapPinIcon, MicIcon, ScreenShareIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  describePermissionKinds,
  describeSitePermission,
  describeSiteStanding,
  permissionPromptTitle,
  siteLabel,
  PERMISSION_KIND_TITLES,
  type PermissionPrompt,
  type PermissionPromptSource,
  type SitePermissionKind,
  type SitePermissionRecord,
} from "@/lib/desktop-site-permissions";
import { cn } from "@/lib/utils";

/** One glyph per kind — what a prompt shows before it has said a word. */
const KIND_ICONS: Record<SitePermissionKind, LucideIcon> = {
  camera: CameraIcon,
  microphone: MicIcon,
  notifications: BellIcon,
  geolocation: MapPinIcon,
  "clipboard-read": ClipboardIcon,
  "display-capture": ScreenShareIcon,
};

export function PermissionKindIcon({ kind, className }: { kind: SitePermissionKind; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? GlobeIcon;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

/**
 * THE ADDRESS BAR'S OWN GLYPH. A lock for https, a globe for everything else —
 * the one thing about a scheme worth a person's attention is that it is NOT
 * secure, and a padlock over a plain-http page would be this surface lying.
 */
export function SiteSecurityIcon({ origin, className }: { origin: string | undefined; className?: string }) {
  const secure = Boolean(origin && origin.startsWith("https://"));
  const Icon = secure ? LockIcon : GlobeIcon;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

export type PermissionAnswer = { decision: "allow" | "once" | "block"; sourceId?: string };

/**
 * The question, and the three buttons. `busy` covers the round trip to the
 * shell so a double-press cannot answer twice — the shell ignores the second
 * one anyway, but a button that stays live after a decision reads as one that
 * did nothing.
 */
export function SitePermissionPrompt({
  prompt,
  onAnswer,
  busy,
}: {
  prompt: PermissionPrompt;
  onAnswer: (answer: PermissionAnswer) => void;
  busy?: boolean;
}) {
  if (prompt.sources) return <ScreenSharePicker prompt={prompt} sources={prompt.sources} onAnswer={onAnswer} busy={busy} />;
  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Site permission request">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground">
          {prompt.kinds.map((kind) => (
            <PermissionKindIcon key={kind} kind={kind} />
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{permissionPromptTitle(prompt)}</p>
          {/* THE PROFILE IS PART OF THE QUESTION, not a footnote: an answer is
              remembered in the cookie jar this session browses in, and the same
              site in another profile will ask again. */}
          <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
            Remembered for this browser profile. “Allow once” is not.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => onAnswer({ decision: "allow" })}>
          Allow
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAnswer({ decision: "once" })}>
          Allow once
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer({ decision: "block" })}>
          Block
        </Button>
      </div>
    </div>
  );
}

/**
 * "WHICH SCREEN" — the share picker, which is also the prompt.
 *
 * Screens first, then windows, the order every OS picker uses: sharing a whole
 * display is the coarse, common answer, and hunting for one window among thirty
 * is the case that needs the list.
 */
function ScreenSharePicker({
  prompt,
  sources,
  onAnswer,
  busy,
}: {
  prompt: PermissionPrompt;
  sources: PermissionPromptSource[];
  onAnswer: (answer: PermissionAnswer) => void;
  busy?: boolean;
}) {
  const ordered = [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "screen" ? -1 : 1));
  const [chosen, setChosen] = useState<string>();
  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Choose what to share">
      <div className="flex items-start gap-2">
        <ScreenShareIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs font-medium text-foreground">{permissionPromptTitle(prompt)}</p>
      </div>
      <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
        {ordered.map((source) => (
          <button
            key={source.id}
            type="button"
            aria-pressed={chosen === source.id}
            onClick={() => setChosen(source.id)}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-1 text-left",
              chosen === source.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/60",
            )}
          >
            {source.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL the shell rendered; nothing for next/image here
              <img src={source.thumbnail} alt="" aria-hidden className="aspect-video w-full rounded-[3px] object-cover" />
            ) : (
              <span aria-hidden className="flex aspect-video w-full items-center justify-center rounded-[3px] bg-muted">
                <ScreenShareIcon className="size-4 text-muted-foreground" />
              </span>
            )}
            <span className="truncate text-[0.625rem] text-muted-foreground">{source.name}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={busy || !chosen} onClick={() => chosen && onAnswer({ decision: "allow", sourceId: chosen })}>
          Share
        </Button>
        {/* CANCEL IS NOT BLOCK. Changing your mind about which window is not a
            decision about the site, so nothing is remembered — the separate
            Block is there for when it is. */}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAnswer({ decision: "allow" })}>
          Cancel
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer({ decision: "block" })}>
          Never allow
        </Button>
      </div>
    </div>
  );
}

/**
 * WHAT THIS SITE HOLDS, under the lock icon — and the one button that takes it
 * back. Every browser puts this here, and a permission granted in a prompt
 * mid-task is only half a permission: the other half is finding it again later
 * and saying no.
 */
export function SitePermissionsPopover({
  origin,
  records,
  onForget,
  onReset,
  busy,
}: {
  origin: string | undefined;
  records: SitePermissionRecord[];
  onForget: (kind: SitePermissionKind) => void;
  onReset: () => void;
  busy?: boolean;
}) {
  if (!origin) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">No site open</p>
        <p className="text-[0.6875rem] text-muted-foreground">Permissions belong to a page’s address; a blank tab has none.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-label="Site permissions">
      <div className="flex items-start gap-2">
        <SiteSecurityIcon origin={origin} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[0.6875rem] text-foreground">{siteLabel(origin)}</p>
          <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{describeSiteStanding(origin, records)}</p>
        </div>
      </div>
      {records.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {records.map((record) => (
            <li key={record.kind} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/60">
              <PermissionKindIcon kind={record.kind} className={record.decision === "allow" ? "text-foreground" : "text-muted-foreground"} />
              <span className="min-w-0 flex-1 truncate text-[0.6875rem]">{describeSitePermission(record)}</span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Forget ${PERMISSION_KIND_TITLES[record.kind]} for ${siteLabel(origin)}`}
                title="Forget this answer. The site asks again next time."
                className="shrink-0 rounded px-1 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                onClick={() => onForget(record.kind)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      {records.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          className="self-start text-destructive hover:text-destructive"
          title={`Forget every answer given to ${siteLabel(origin)} in this profile. It asks again next time.`}
          onClick={onReset}
        >
          Reset permissions
        </Button>
      )}
    </div>
  );
}

/**
 * macOS SAID NO AFTER THE PERSON SAID YES — the one failure the page cannot
 * explain, because all it ever sees is NotAllowedError. Rendered on the panel's
 * error strip, with the pane to open named.
 */
export function describePermissionDenial(denial: { origin: string; kinds: SitePermissionKind[]; reason: string }): string {
  return `${siteLabel(denial.origin)} could not use your ${describePermissionKinds(denial.kinds)}. ${denial.reason}`;
}
