"use client";

/**
 * The sidebar's footer row — three icons, by the user's spec: Settings and
 * Usage left (their words live in tooltips and aria-labels), the app-update
 * control right. SETTINGS COMES FIRST (#389): it is the one a person reaches
 * for, and Usage is the one they look at.
 *
 * The update icon is one stateful control over the shell's updater bridge,
 * and it reads as THREE STATES — check, download, apply — drawn from
 * `useDesktopUpdate()` so this rail and Settings ▸ Updates cannot disagree
 * about what the updater is doing. A Dev build has no published feed and
 * renders nothing here: its local-checkout updater is a File-menu item, not a
 * permanent glyph in the rail. In a plain browser tab (no bridge) the right
 * side renders nothing either.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartNoAxesColumnIcon, DownloadIcon, Loader2Icon, PowerIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useDesktopUpdate } from "@/lib/desktop-updates";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateToast } from "@/components/ui/update-toast";
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

function UpdateButton() {
  const { supported, path, status, action, label, busy, failure, act } = useDesktopUpdate();

  /**
   * THE DEV BUILD'S LOCAL-CHECKOUT UPDATER IS NOT A RAIL CONTROL.
   *
   * It used to paint a wrench here, next to Usage and Settings — a permanent
   * glyph in the one strip a person sees on every screen, for an action only a
   * Dev build can take and only its builder ever wants. File ▸ "Update from
   * Local Checkout…" is where it lives (apps/desktop/main.js), which is where
   * a developer-only rebuild belongs.
   *
   * The path is still DETECTED rather than ignored, because it is what tells
   * this component there is no published feed to offer either — a Dev build
   * showing "Check for app updates" would be a button that cannot answer.
   */
  if (!supported || path === "none" || path === "local") return null;

  const failed = Boolean(failure) || status.status === "error";

  return (
    // POSITIONED, because the toast anchors to this control rather than to a
    // corner of the screen — see components/ui/update-toast.tsx.
    <div data-slot="update-control" className="relative flex items-center">
      <UpdateToast status={status} />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-live="polite"
              disabled={busy}
              onClick={act}
              className={cn(
                iconButton(),
                action === "apply" && "text-primary",
                failed && "text-destructive",
                busy && "cursor-default hover:bg-transparent",
              )}
            >
              {action === "restarting" || status.status === "checking" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : action === "download" ? (
                // The DOWNLOAD glyph, with how far along it is — the state the
                // old idle arrow was borrowing its look from.
                <span className="relative flex items-center justify-center">
                  <DownloadIcon className="size-4" />
                  <span className="absolute -bottom-1.5 text-[0.5rem] font-semibold tabular-nums">{Math.round(status.percent ?? 0) || ""}</span>
                </span>
              ) : action === "apply" ? (
                <PowerIcon className="size-4" />
              ) : (
                // CHECK — idle, failed, or up to date. The arrow-circle, which
                // is the glyph for "ask again", not for "fetch this".
                <RefreshCwIcon className="size-4" />
              )}
            </button>
          }
        />
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The whole footer: icon row, Settings + Usage left, update right. */
export function AppSidebarFooterRow({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex items-center gap-0.5 p-1">
      <FooterLink href="/settings" label="Settings" onNavigate={onNavigate}>
        <SettingsIcon className="size-4" />
      </FooterLink>
      <FooterLink href="/usage" label="Usage" onNavigate={onNavigate}>
        <ChartNoAxesColumnIcon className="size-4" />
      </FooterLink>
      <div className="flex-1" />
      <UpdateButton />
    </div>
  );
}
