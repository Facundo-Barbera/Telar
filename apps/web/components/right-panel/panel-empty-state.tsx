import {
  ActivityIcon,
  GitBranchIcon,
  GlobeIcon,
  PanelsTopLeftIcon,
} from "lucide-react";

const surfaces = [
  {
    key: "browser",
    label: "Browser",
    description: "Open a local app or URL.",
    icon: GlobeIcon,
  },
  {
    key: "git",
    label: "Git",
    description: "Review changes and worktrees.",
    icon: GitBranchIcon,
  },
  {
    key: "activity",
    label: "Activity",
    description: "Inspect subagents and Ultras.",
    icon: ActivityIcon,
  },
] as const;

export function PanelEmptyState({
  onOpenActivity,
  onOpenGit,
  onOpenBrowser,
}: {
  onOpenActivity: () => void;
  onOpenGit: () => void;
  onOpenBrowser: () => void;
}) {
  const actions = {
    activity: onOpenActivity,
    git: onOpenGit,
    browser: onOpenBrowser,
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        <PanelsTopLeftIcon className="mx-auto size-8 text-muted-foreground/40" />
        <h2 className="mt-4 font-heading text-sm font-medium">Open a surface</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Choose what to keep beside the conversation.
        </p>
        <div className="mt-5 grid gap-2 text-left sm:grid-cols-3">
          {surfaces.map((surface) => {
            const Icon = surface.icon;
            return (
              <button
                key={surface.key}
                type="button"
                onClick={actions[surface.key]}
                className="rounded-2xl border border-border bg-background/70 p-3 transition-colors hover:bg-muted/60"
              >
                <Icon className="size-4 text-muted-foreground" />
                <div className="mt-3 text-xs font-medium text-foreground">{surface.label}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {surface.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
