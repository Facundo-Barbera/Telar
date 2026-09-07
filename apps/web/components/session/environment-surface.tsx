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
import { PanelEmpty } from "@/components/ui/panel";
import { PackagesPanel } from "@/components/settings/packages-panel";

export function EnvironmentSurface({ sessionId, projectId, kernel, onRestart }: { sessionId?: string; projectId?: string; kernel: KernelState; onRestart: () => void }) {
  if (!sessionId) return <PanelEmpty icon={<PackageIcon />} title="No session">An environment belongs to a session&apos;s project.</PanelEmpty>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PackagesPanel scope={{ sessionId }} kernelLive={kernel !== "none" && kernel !== "dead"} onRestartKernel={onRestart} dense />
      {projectId && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-[0.625rem] text-muted-foreground">
          <SettingsIcon className="size-3" />
          <span>Environments, Python versions and conda live in</span>
          <Link href={`/projects/${encodeURIComponent(projectId)}/settings?section=data-science`} className="underline-offset-2 hover:underline">project settings</Link>
        </div>
      )}
    </div>
  );
}
