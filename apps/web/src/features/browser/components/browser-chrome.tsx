"use client";

import { useState } from "react";
import { CameraIcon, CheckIcon, DownloadIcon, KeyRoundIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/ui/context-menu";
import { useNativeViewOverlay } from "@/platform/desktop/native-view-overlay";
import { cn } from "@/ui/utils";
import type { BrowserUi } from "../hooks/use-browser-session";
import { BROWSER_NOT_AUTHORIZED, describeDownload, describeExtensionHealth, needsBrowserAuthorization } from "../model";

export const menuRow =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.75rem] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

export function Divider() {
  return <div aria-hidden className="my-1 h-px bg-border" />;
}

/** A menu row with the leading check every row reserves room for. */
export function CheckRow({ on, onClick, children, ...rest }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn(menuRow, on && "text-foreground")} {...rest}>
      <CheckIcon className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
      {children}
    </button>
  );
}

/** A press takes the viewport; the right-click menu offers the full page too. */
export function CameraButton({ busy, onCapture }: { busy: boolean; onCapture: (fullPage: boolean) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useNativeViewOverlay(menuOpen);
  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger className="contents">
        <button
          type="button"
          aria-label="Screenshot this page"
          title={"Attach a screenshot of this page to your message.\nRight-click for the full page."}
          disabled={busy}
          onClick={() => onCapture(false)}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <CameraIcon className="size-3.5" />}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuItem onClick={() => onCapture(false)}>Screenshot the viewport</ContextMenuItem>
        <ContextMenuItem onClick={() => onCapture(true)}>Screenshot the full page</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The password manager: its health sentence is the tooltip and the accessible name. */
export function ExtensionButton({ b, keyButtonRef }: { b: BrowserUi; keyButtonRef: React.RefObject<HTMLButtonElement | null> }) {
  const { extension } = b;
  if (!extension || extension.phase === "unavailable") return null;
  const health = describeExtensionHealth(extension);
  return (
    <button
      ref={keyButtonRef}
      type="button"
      aria-label={extension.phase === "ready" ? `Open ${extension.name ?? "password manager"} — ${health.text}` : `${extension.name ?? "Password manager"}: ${health.text}`}
      title={`${extension.name ?? "Password manager"}: ${health.text}`}
      disabled={extension.phase !== "ready"}
      onClick={() => void b.openPasswordManager()}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium",
        health.tone === "error" ? "text-destructive hover:bg-muted" : extension.phase === "ready" ? "text-muted-foreground hover:bg-muted hover:text-foreground" : "text-muted-foreground/60",
      )}
    >
      {extension.phase === "installing" || extension.phase === "loading" ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : extension.phase === "ready" && extension.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={extension.icon} alt="" width={14} height={14} className="size-3.5" />
      ) : (
        <KeyRoundIcon className="size-3.5" />
      )}
      {health.tone === "error" ? <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" /> : null}
    </button>
  );
}

const STRIP = {
  error: ["items-center border-destructive/30 bg-destructive/10 text-destructive", "hover:bg-destructive/20"],
  warning: ["items-start border-warning/40 bg-warning/10 text-foreground", "hover:bg-warning/20"],
  info: ["items-center border-border bg-muted/40 text-foreground", "hover:bg-muted"],
} as const;

function Strip({ tone, onDismiss, children }: { tone: keyof typeof STRIP; onDismiss: () => void; children: React.ReactNode }) {
  const [look, hover] = STRIP[tone];
  return (
    <div role={tone === "info" ? "status" : "alert"} className={cn("flex shrink-0 gap-2 border-b px-3 py-1.5 text-2xs", look)}>
      {children}
      <button type="button" onClick={onDismiss} className={cn("shrink-0 rounded px-1.5 py-0.5", hover)}>
        Dismiss
      </button>
    </div>
  );
}

/** The action, extension, permission and download strips under the toolbar. */
export function Notices({ b }: { b: BrowserUi }) {
  const { actionError, extensionError, permissionDenial, download } = b;
  const [authorizationDismissed, setAuthorizationDismissed] = useState(false);
  return (
    <>
      {needsBrowserAuthorization(b.extension) && !authorizationDismissed && (
        <Strip tone="warning" onDismiss={() => setAuthorizationDismissed(true)}>
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{BROWSER_NOT_AUTHORIZED}</span>
          {b.bridge.openPasswordManagerApp && (
            <button type="button" onClick={() => void b.bridge.openPasswordManagerApp?.()} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-warning/20">Open 1Password</button>
          )}
        </Strip>
      )}
      {actionError && (
        <Strip tone="error" onDismiss={() => b.setActionError(undefined)}>
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
        </Strip>
      )}
      {extensionError && (
        <Strip tone="error" onDismiss={() => b.setExtensionError(undefined)}>
          <span className="min-w-0 flex-1 truncate">{extensionError}</span>
        </Strip>
      )}
      {permissionDenial && (
        <Strip tone="warning" onDismiss={() => b.setPermissionDenial(undefined)}>
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{permissionDenial}</span>
        </Strip>
      )}
      {download && (
        <Strip tone="info" onDismiss={() => b.setDownload(undefined)}>
          <DownloadIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={download.path}>{describeDownload(download)}</span>
          {download.state === "completed" && b.bridge.revealDownload && (
            <button type="button" onClick={() => void b.bridge.revealDownload?.(download.path)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-muted">Show in folder</button>
          )}
        </Strip>
      )}
    </>
  );
}
