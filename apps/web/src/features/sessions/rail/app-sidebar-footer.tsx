"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartNoAxesColumnIcon, DownloadIcon, FlameIcon, Loader2Icon, PowerIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { FeedbackDialog, useDesktopUpdate, UpdateToast, RestartUpdateDialog } from "@/features/updates";
import { formatCpu, useRunawayNotice, type RunawayRenderer } from "@/platform/desktop/desktop-metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { ProgressRing } from "@/ui/progress-ring";
import { cn } from "@/ui/utils";

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
  const { supported, path, status, action, label, busy, failure, act, restart } = useDesktopUpdate();

  if (!supported || path === "none" || path === "local") return null;

  const failed = Boolean(failure) || status.status === "error";

  return (
    <div data-slot="update-control" className="relative flex items-center">
      <UpdateToast status={status} />
      <RestartUpdateDialog restart={restart} />
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
                status.status === "downloading" && status.percent !== undefined ? (
                  <ProgressRing percent={status.percent} label="Downloading update" />
                ) : (
                  <DownloadIcon className="size-4" />
                )
              ) : action === "apply" ? (
                <PowerIcon className="size-4" />
              ) : (
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

export function RunawayIndicator() {
  const notice = useRunawayNotice();
  const hot = notice?.renderers ?? [];
  if (hot.length === 0) return null;

  const worst = [...hot].sort(
    (a: RunawayRenderer, b: RunawayRenderer) => Number(a.killed) - Number(b.killed) || b.percent - a.percent,
  )[0]!;
  const label = worst.killed
    ? `Stopped a runaway renderer at ${formatCpu(worst.percent)} of a core`
    : `A renderer is at ${formatCpu(worst.percent)} of a core with no page open`;
  const detail = worst.killed
    ? `pid ${worst.pid} was hosting no page${worst.origins.length > 0 ? ` — service workers running with no tab: ${worst.origins.join(", ")}` : ""}.`
    : `pid ${worst.pid}, for ${worst.polls} polls. The shell will not stop it: no service worker is running without a tab to name it as.`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href="/usage"
            aria-label={label}
            className={cn(iconButton(), "text-warning hover:text-warning")}
          >
            <FlameIcon className="size-4" />
          </Link>
        }
      />
      <TooltipContent side="top">
        <span className="block max-w-64">
          {label}. {detail} {hot.length > 1 ? `${hot.length} in all. ` : ""}Open Usage for the figures.
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebarFooterRow({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex items-center gap-0.5 p-1">
      <FooterLink href="/settings" label="Settings" onNavigate={onNavigate}>
        <SettingsIcon className="size-4" />
      </FooterLink>
      <FooterLink href="/usage" label="Usage" onNavigate={onNavigate}>
        <ChartNoAxesColumnIcon className="size-4" />
      </FooterLink>
      <FeedbackDialog triggerClassName={iconButton()} />
      <div className="flex-1" />
      <RunawayIndicator />
      <UpdateButton />
    </div>
  );
}
