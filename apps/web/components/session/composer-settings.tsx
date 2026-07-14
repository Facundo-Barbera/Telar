"use client";

// 1.2 — collapse the composer's button crowd (permission · model · effort)
// into ONE settings popover fronted by a compact config chip that reads back
// the active model, permission mode and effort at a glance. Auto Mode is the
// default. Ported from the owner-verdicted demo (lib/demo-gallery/input/
// settings-popover.tsx + shared.tsx). Provider/account stay as their own
// pre-session controls in the footer; this chip is the Claude config trio.
//
// Real data only: the model list is the live catalog fetched by the composer
// (modelOptions), the effort list is the provider's real EFFORT_OPTIONS, and
// permissions are the real PERMISSION_MODE_OPTIONS — nothing is hardcoded here.

import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  GaugeIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/models";
import type { ClientPermissionMode } from "@/lib/permission-modes";

type PermOption = { value: ClientPermissionMode; label: string; description: string };
type EffortOpt = { id: string; label: string; blurb: string };

const permIcon = (v: ClientPermissionMode) =>
  v === "auto" ? (
    <ZapIcon className="size-3.5 text-primary" />
  ) : v === "acceptEdits" ? (
    <CheckIcon className="size-3.5" />
  ) : (
    <BotIcon className="size-3.5" />
  );

function chipClass(active: boolean) {
  return cn(
    "flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors",
    "hover:bg-accent hover:text-foreground",
    active && "border-ring bg-accent text-foreground",
  );
}

function SectionLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

// A labelled segmented control — single-tap, no dropdown-inside-a-dropdown.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function ModelRow({
  model,
  selected,
  onClick,
}: {
  model: ModelInfo;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected && <CheckIcon className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{model.name}</span>
          <span className="rounded border border-border px-1 py-0 text-[10px] text-muted-foreground">
            {model.context}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{model.blurb}</span>
      </span>
    </button>
  );
}

export function ComposerSettings({
  project,
  open,
  onOpenChange,
  model,
  setModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  modelOptions,
  effortOptions,
  permissionOptions,
}: {
  project: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  permissionMode: ClientPermissionMode;
  setPermissionMode: (v: ClientPermissionMode) => void;
  modelOptions: ModelInfo[];
  effortOptions: EffortOpt[];
  permissionOptions: PermOption[];
}) {
  const activeModel = modelOptions.find((m) => m.id === model);
  const modelLabel = activeModel?.name ?? model;
  const permLabel = permissionOptions.find((p) => p.value === permissionMode)?.label ?? "Ask me";
  const permDescription = permissionOptions.find((p) => p.value === permissionMode)?.description;
  const auto = permissionMode === "auto";
  const effortLabel = effortOptions.find((e) => e.id === effort)?.label;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button type="button" {...props} className={chipClass(open)}>
            <SparklesIcon className="size-3.5 text-foreground/70" />
            <span className="text-foreground">{modelLabel}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex items-center gap-1">
              {auto ? (
                <ZapIcon className="size-3 text-primary" />
              ) : (
                <ShieldCheckIcon className="size-3" />
              )}
              {permLabel}
            </span>
            {effort !== "default" && effortLabel && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{effortLabel}</span>
              </>
            )}
          </button>
        )}
      />
      <PopoverContent align="start" sideOffset={8} className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b px-3.5 py-2.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <SettingsIcon className="size-4 text-muted-foreground" />
            Agent configuration
          </span>
          <Badge variant="outline" className="gap-1 text-[10px]">
            <BotIcon className="size-3" />
            Claude
          </Badge>
        </div>

        <div className="max-h-[min(66vh,560px)] space-y-4 overflow-y-auto p-3.5">
          {/* Permissions — Auto is the default and reads as such. */}
          <div className="space-y-2">
            <SectionLabel icon={<ShieldCheckIcon className="size-3" />}>Permissions</SectionLabel>
            <Segmented<ClientPermissionMode>
              value={permissionMode}
              onChange={setPermissionMode}
              options={[
                { value: "auto", label: "Auto", icon: permIcon("auto") },
                { value: "acceptEdits", label: "Accept edits", icon: permIcon("acceptEdits") },
                { value: "default", label: "Ask me", icon: permIcon("default") },
              ]}
            />
            <p className="px-0.5 text-xs text-muted-foreground">
              {permDescription}
              {auto && (
                <span className="ml-1 font-medium text-primary">Default for new projects.</span>
              )}
            </p>
          </div>

          <Separator />

          {/* Model list — the live catalog. */}
          <div className="space-y-1.5">
            <SectionLabel icon={<SparklesIcon className="size-3" />}>Model</SectionLabel>
            <div className="space-y-0.5">
              {modelOptions.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={model === m.id}
                  onClick={() => setModel(m.id)}
                />
              ))}
            </div>
          </div>

          <Separator />

          {/* Effort — "Auto" (default) omits effort from the POST body; the
              rest map 1:1 to the provider's EFFORT_OPTIONS. */}
          <div className="space-y-2">
            <SectionLabel icon={<GaugeIcon className="size-3" />}>Reasoning effort</SectionLabel>
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
              {[{ id: "default", label: "Auto" }, ...effortOptions].map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setEffort(e.id)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                    effort === e.id
                      ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <p className="px-0.5 text-xs text-muted-foreground">
              {effort === "default"
                ? "Let the model choose its own effort."
                : effortOptions.find((e) => e.id === effort)?.blurb}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3.5 py-2.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-primary" />
            Remembered for <span className="font-medium text-foreground">{project}</span>
          </span>
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
