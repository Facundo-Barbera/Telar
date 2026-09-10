"use client";

/**
 * The sidebar's footer row — three icons, by the user's spec: Usage and
 * Settings left (their words live in tooltips and aria-labels), the
 * app-update control right. The update icon is one stateful control over the
 * shell's updater bridge (lib/desktop-updates.ts): check → spinner →
 * download progress → restart-to-install → error-with-message. On a Dev
 * build it drives the OTHER updater — the local-checkout window
 * (`openLocalUpdater`) — because Dev has no published feed; the two paths
 * stay distinct but both are reachable from here. In a plain browser tab
 * (no bridge) the right side renders nothing.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartNoAxesColumnIcon, DownloadIcon, HammerIcon, Loader2Icon, RefreshCwIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { desktopUpdates, updateStatusHint, type UpdateStatus } from "@/lib/desktop-updates";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const iconButton = (active = false) =>
  cn(
    "flex size-8 items-center justify-center rounded-md text-sidebar-foreground/80 transition-colors",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active && "bg-sidebar-accent text-sidebar-accent-foreground",
  );

function FooterLink({ href, label, onNavigate, children }: { href: string; label: string; onNavigate: () => void; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link href={href} aria-label={label} onClick={onNavigate} className={iconButton(pathname.startsWith(href))}>
            {children}
          </Link>
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Which updater this install has: the published feed, the Dev
 *  local-checkout window, neither, or "could not ask" (retryable). */
type Path = "feed" | "local" | "none" | "unknown";

function UpdateButton() {
  const bridge = desktopUpdates();
  const [path, setPath] = useState<Path>("unknown");
  const [status, setStatus] = useState<UpdateStatus>({ status: "not-available" });
  /** A failure of THIS surface's own calls (a rejected check/install/prefs
   *  read) — shown on the button, retryable, never silently swallowed. */
  const [failure, setFailure] = useState<string>();

  const readPrefs = useCallback(() => {
    if (!bridge) return;
    bridge
      .getPrefs()
      .then((prefs) => {
        setFailure(undefined);
        setPath(prefs.localUpdater ? "local" : prefs.configured ? "feed" : "none");
      })
      .catch((error: unknown) => {
        // NOT a permanent hide: the button stays, says why, and retries.
        setPath("unknown");
        setFailure(`Could not read updater state: ${error instanceof Error ? error.message : String(error)}. Click to retry.`);
      });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    /**
     * A PUSH BEATS A PULL, WHATEVER ORDER THEY RESOLVE IN. The pull below is
     * an async IPC round-trip asking what state we MISSED; a push that lands
     * while it is in flight is newer by construction. Without this flag a
     * slow `status()` answering "downloading 40%" would rewind a
     * "downloaded" that had already arrived — and downloaded is the one
     * state that never comes again.
     */
    let pushed = false;
    readPrefs();
    // The CURRENT state, not just future pushes: `update-downloaded` is never
    // re-emitted, so a remounted footer must ask what it missed.
    void bridge
      .status?.()
      .then((current) => {
        if (live && !pushed && current && current.status !== "unsupported") setStatus(current);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStatus((next) => {
      if (!live) return;
      pushed = true;
      if (next.status === "unsupported") setPath((current) => (current === "feed" ? "none" : current));
      else {
        setFailure(undefined);
        setStatus(next);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, readPrefs]);

  if (!bridge || path === "none") return null;

  // ── the Dev build's path: the local-checkout window ─────────────────────
  if (path === "local") {
    const label = failure ?? "Update from local checkout…";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              onClick={() =>
                void bridge
                  .openLocalUpdater?.()
                  .then((result) => {
                    if (result && !result.ok) setFailure(result.error ?? "The local updater window could not open.");
                    else setFailure(undefined);
                  })
                  .catch((error: unknown) => setFailure(`Local updater failed: ${error instanceof Error ? error.message : String(error)}`))
              }
              className={cn(iconButton(), failure && "text-destructive")}
            >
              {failure ? <TriangleAlertIcon className="size-4" /> : <HammerIcon className="size-4" />}
            </button>
          }
        />
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    );
  }

  // ── the published-feed path (and the "could not ask" retry state) ───────
  const busy = status.status === "checking";
  const progress = status.status === "available" || status.status === "downloading";
  const ready = status.status === "downloaded";
  const failed = Boolean(failure) || status.status === "error";
  const label =
    failure ??
    (ready ? `${updateStatusHint(status)} Restart to install.` : progress || busy || status.status === "error" ? updateStatusHint(status) : "Check for app updates");
  const act = () => {
    if (path === "unknown") return readPrefs();
    if (ready) {
      void bridge.install().catch((error: unknown) => setFailure(`Install failed: ${error instanceof Error ? error.message : String(error)}`));
    } else if (!busy && !progress) {
      void bridge.check().catch((error: unknown) => setFailure(`Update check failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-live="polite"
            disabled={busy || progress}
            onClick={act}
            className={cn(iconButton(), ready && "text-primary", failed && "text-destructive", (busy || progress) && "cursor-default hover:bg-transparent")}
          >
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : progress ? (
              <span className="relative flex items-center justify-center">
                <Loader2Icon className="size-4 animate-spin" />
                <span className="absolute text-[0.5rem] font-semibold tabular-nums">{Math.round(status.percent ?? 0) || ""}</span>
              </span>
            ) : ready ? (
              <RefreshCwIcon className="size-4" />
            ) : failed ? (
              <TriangleAlertIcon className="size-4" />
            ) : (
              <DownloadIcon className="size-4" />
            )}
          </button>
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The whole footer: icon row, Usage + Settings left, update right. */
export function AppSidebarFooterRow({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex items-center gap-0.5 p-1">
      <FooterLink href="/usage" label="Usage" onNavigate={onNavigate}>
        <ChartNoAxesColumnIcon className="size-4" />
      </FooterLink>
      <FooterLink href="/settings" label="Settings" onNavigate={onNavigate}>
        <SettingsIcon className="size-4" />
      </FooterLink>
      <div className="flex-1" />
      <UpdateButton />
    </div>
  );
}
