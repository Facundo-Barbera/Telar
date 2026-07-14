"use client";

// Concern 1.2 (variant) — the composer REMEMBERS the last configuration per
// project, and a brand-new project starts in Auto Mode. Switch projects and the
// chip snaps to that project's saved config; edit it and the memory updates;
// the fresh project boots with the Auto default until you touch it.
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  FolderIcon,
  PlusIcon,
  SparklesIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import {
  ChipContent,
  chipClass,
  DEFAULT_CONFIG,
  EFFORTS,
  MODELS,
  ModelRow,
  PERM_MODES,
  Segmented,
  SectionLabel,
  effortLabel,
  modelName,
  permLabel,
  type Config,
  type PermMode,
} from "./shared";

type Project = { name: string; fresh?: boolean };

const PROJECTS: Project[] = [
  { name: "telar-core" },
  { name: "web-dashboard" },
  { name: "billing-svc", fresh: true },
];

// Seeded memory — what each project last used. A fresh project has no entry,
// so it falls back to DEFAULT_CONFIG (Auto Mode on).
const SEED: Record<string, Config> = {
  "telar-core": { provider: "claude", model: "claude-fable-5", effort: "high", perm: "acceptEdits" },
  "web-dashboard": { provider: "claude", model: "claude-haiku-4-5", effort: "default", perm: "default" },
};

export function RememberedConfigDemo() {
  const [memory, setMemory] = useState<Record<string, Config>>(SEED);
  const [project, setProject] = useState("telar-core");
  const [open, setOpen] = useState(false);

  const config = memory[project] ?? DEFAULT_CONFIG;
  const remembered = project in memory;
  const setConfig = (c: Config) => setMemory((m) => ({ ...m, [project]: c }));
  const patch = (p: Partial<Config>) => setConfig({ ...config, ...p });

  return (
    <div className="min-h-full bg-background p-6 sm:p-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">Config is remembered per project</h2>
          <p className="text-sm text-muted-foreground">
            Each project keeps its own last-used model, permission mode and effort. Switch
            projects below — the composer chip snaps to that project's saved config. A project
            you've never configured (billing-svc) boots in Auto Mode.
          </p>
        </div>

        {/* Project switcher */}
        <div className="flex flex-wrap gap-2">
          {PROJECTS.map((p) => {
            const cfg = memory[p.name] ?? DEFAULT_CONFIG;
            const isNew = !(p.name in memory);
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  setProject(p.name);
                  setOpen(false);
                }}
                className={cn(
                  "flex min-w-[168px] flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  project === p.name
                    ? "border-ring bg-accent"
                    : "border-border hover:bg-accent/50",
                )}
              >
                <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                  <FolderIcon className="size-3.5 text-muted-foreground" />
                  {p.name}
                  {isNew && (
                    <Badge variant="outline" className="ml-auto gap-1 text-[10px] text-primary">
                      <ZapIcon className="size-3" />
                      Auto
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <SparklesIcon className="size-3" />
                  {modelName(cfg.model)} · {permLabel(cfg.perm)}
                  {cfg.effort !== "default" && ` · ${effortLabel(cfg.effort)}`}
                </span>
              </button>
            );
          })}
        </div>

        {/* Composer for the active project */}
        <div className="space-y-2">
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Composer — {project}
            {!remembered && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] normal-case text-primary">
                using Auto default
              </span>
            )}
          </span>
          <div className="mx-auto w-full overflow-hidden rounded-xl border border-input bg-card shadow-sm">
            <textarea
              readOnly
              rows={2}
              placeholder={`Ask about ${project}…`}
              className="w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Add">
                <PlusIcon className="size-4" />
              </Button>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                  render={(props) => (
                    <button type="button" {...props} className={chipClass(open)}>
                      <ChipContent config={config} />
                    </button>
                  )}
                />
                <PopoverContent align="start" sideOffset={8} className="w-[340px] p-0">
                  <div className="flex items-center justify-between border-b px-3.5 py-2.5 text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <FolderIcon className="size-4 text-muted-foreground" />
                      {project}
                    </span>
                    {remembered ? (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <CheckIcon className="size-3" /> saved
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-[10px] text-primary">
                        <ZapIcon className="size-3" /> Auto default
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-4 p-3.5">
                    <div className="space-y-2">
                      <SectionLabel icon={<ShieldCheckIcon className="size-3" />}>Permissions</SectionLabel>
                      <Segmented<PermMode>
                        value={config.perm}
                        onChange={(v) => patch({ perm: v })}
                        options={[
                          { value: "auto", label: "Auto", icon: <ZapIcon className="size-3.5 text-primary" /> },
                          { value: "acceptEdits", label: "Accept edits", icon: <CheckIcon className="size-3.5" /> },
                          { value: "default", label: "Ask me", icon: <BotIcon className="size-3.5" /> },
                        ]}
                      />
                    </div>
                    <Separator />
                    <div className="space-y-1.5">
                      <SectionLabel icon={<ZapIcon className="size-3" />}>Model</SectionLabel>
                      <div className="space-y-0.5">
                        {MODELS.map((m) => (
                          <ModelRow
                            key={m.id}
                            model={m}
                            selected={config.model === m.id}
                            onClick={() => patch({ model: m.id })}
                          />
                        ))}
                      </div>
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      <SectionLabel>Reasoning effort</SectionLabel>
                      <Segmented
                        value={config.effort}
                        onChange={(v) => patch({ effort: v })}
                        options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))}
                      />
                    </div>
                  </div>
                  <div className="border-t bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
                    Changes here are saved to <span className="font-medium text-foreground">{project}</span> and
                    restored next time you open it.
                  </div>
                </PopoverContent>
              </Popover>
              <span className="ml-auto" />
              <Button size="icon-sm" aria-label="Send">
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {remembered ? (
              <>
                Restored <span className="font-medium text-foreground">{permLabel(config.perm)}</span> ·{" "}
                <span className="font-medium text-foreground">{modelName(config.model)}</span> from the last
                session in this project.
              </>
            ) : (
              <>New project — no saved config yet, so it starts in Auto Mode. Edit it once and it sticks.</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
