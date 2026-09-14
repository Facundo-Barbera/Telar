"use client";

/**
 * THE ENVIRONMENT, FROM INSIDE A SESSION: which one this session resolved to
 * (a worktree session may resolve `.venv` to its own tree), what is in it,
 * and a way to add to it without leaving the conversation. The full manager —
 * creating environments, installing uv or Python — stays in project settings;
 * this is the day-two surface: "I need seaborn".
 */
import { PackageIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { KernelState } from "@/lib/ds";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { PanelEmpty } from "@/components/ui/panel";
import { PackagesPanel } from "@/components/settings/packages-panel";

export function EnvironmentSurface({ sessionId, projectId, kernel, onRestart }: { sessionId?: string; projectId?: string; kernel: KernelState; onRestart: () => void }) {
  if (!sessionId) return <PanelEmpty icon={<PackageIcon />} title="No session">An environment belongs to a session&apos;s project.</PanelEmpty>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PackagesPanel scope={{ sessionId }} kernelLive={kernel !== "none" && kernel !== "dead"} onRestartKernel={onRestart} dense />
      {projectId && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground">
          <SettingsIcon className="size-3" />
          <span>Environments, Python versions and conda live in</span>
          {/* The project's own groups on Settings ▸ Projects, which is where the
              Data science editor moved when the standalone page went (#363). */}
          <Link href={projectSettingsHref(projectId)} className="underline-offset-2 hover:underline">project settings</Link>
        </div>
      )}
    </div>
  );
}
