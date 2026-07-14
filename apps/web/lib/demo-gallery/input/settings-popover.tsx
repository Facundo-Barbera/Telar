"use client";

// Concern 1.2 — collapse the composer's button crowd (provider · account ·
// permission · model · effort = 4–5 selects) into ONE settings popover fronted
// by a compact config chip. Auto Mode is the default. Interactive: the chip
// opens/closes the popover; every control writes back to the chip live.
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useState } from "react";
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  PlusIcon,
  SettingsIcon,
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
  type Config,
  type PermMode,
} from "./shared";

function ComposerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="overflow-hidden rounded-xl border border-input bg-card shadow-sm">
        <textarea
          readOnly
          rows={2}
          placeholder="Ask about telar-core… (&quot;/&quot; for commands)"
          className="w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">{children}</div>
      </div>
    </div>
  );
}

function SettingsPopover({
  config,
  setConfig,
  open,
  onOpenChange,
}: {
  config: Config;
  setConfig: (c: Config) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const patch = (p: Partial<Config>) => setConfig({ ...config, ...p });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button type="button" {...props} className={chipClass(open)}>
            <ChipContent config={config} />
          </button>
        )}
      />
      <PopoverContent align="start" className="w-[340px] p-0" sideOffset={8}>
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
            <SectionLabel icon={<ShieldCheckIcon className="size-3" />}>
              Permissions
            </SectionLabel>
            <Segmented<PermMode>
              value={config.perm}
              onChange={(v) => patch({ perm: v })}
              options={[
                { value: "auto", label: "Auto", icon: <ZapIcon className="size-3.5 text-primary" /> },
                { value: "acceptEdits", label: "Accept edits", icon: <CheckIcon className="size-3.5" /> },
                { value: "default", label: "Ask me", icon: <BotIcon className="size-3.5" /> },
              ]}
            />
            <p className="px-0.5 text-xs text-muted-foreground">
              {PERM_MODES.find((p) => p.value === config.perm)?.description}
              {config.perm === "auto" && (
                <span className="ml-1 font-medium text-primary">Default for new projects.</span>
              )}
            </p>
          </div>

          <Separator />

          {/* Model list */}
          <div className="space-y-1.5">
            <SectionLabel icon={<Sparkle />}>Model</SectionLabel>
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

          {/* Effort */}
          <div className="space-y-2">
            <SectionLabel>Reasoning effort</SectionLabel>
            <Segmented
              value={config.effort}
              onChange={(v) => patch({ effort: v })}
              options={EFFORTS.map((e) => ({ value: e.id, label: e.label }))}
            />
            <p className="px-0.5 text-xs text-muted-foreground">
              {EFFORTS.find((e) => e.id === config.effort)?.blurb}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3.5 py-2.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-primary" />
            Remembered for <span className="font-medium text-foreground">telar-core</span>
          </span>
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Sparkle() {
  return <ZapIcon className="size-3" />;
}

export function SettingsPopoverDemo() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-full bg-background p-6 sm:p-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">One settings popover, one chip</h2>
          <p className="text-sm text-muted-foreground">
            The production footer stacks four-to-five selects side by side. Here the whole
            configuration collapses to a single chip that reads back the active model,
            permission mode and effort at a glance. Click it to open the popover.
          </p>
        </div>

        {/* BEFORE — the current button crowd, non-interactive, for comparison. */}
        <div className="space-y-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Current — the button crowd
          </span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 p-2.5 opacity-80">
            {["Claude", "Ask me", "Sonnet 5", "Effort"].map((l) => (
              <span
                key={l}
                className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground"
              >
                {l}
                <ChevronDown />
              </span>
            ))}
            <span className="ml-auto flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ArrowUpIcon className="size-4" />
            </span>
          </div>
        </div>

        {/* AFTER — collapsed bar with the settings popover. */}
        <div className="space-y-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Redesigned — collapsed bar
          </span>
          <ComposerShell>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Add attachment">
              <PlusIcon className="size-4" />
            </Button>
            <SettingsPopover
              config={config}
              setConfig={setConfig}
              open={open}
              onOpenChange={setOpen}
            />
            <span className="ml-auto" />
            <Button size="icon-sm" aria-label="Send">
              <ArrowUpIcon className="size-4" />
            </Button>
          </ComposerShell>
          <p className="text-xs text-muted-foreground">
            Auto Mode is on by default — the chip shows the ⚡ lightning marker and the popover
            labels it the project default.
          </p>
        </div>

        {/* The open popover state, pinned open, so a reviewer sees it without a click. */}
        <div className="space-y-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Popover — open state
          </span>
          <StaticPopoverPreview config={config} setConfig={setConfig} />
        </div>
      </div>
    </div>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" className="size-3 opacity-50" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A non-floating copy of the popover body so the "open" state is always visible
// on the stage (the real one is a floating overlay tied to a click).
function StaticPopoverPreview({
  config,
  setConfig,
}: {
  config: Config;
  setConfig: (c: Config) => void;
}) {
  const patch = (p: Partial<Config>) => setConfig({ ...config, ...p });
  return (
    <div className={cn("w-[340px] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md")}>
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
          <p className="px-0.5 text-xs text-muted-foreground">
            {PERM_MODES.find((p) => p.value === config.perm)?.description}
            {config.perm === "auto" && (
              <span className="ml-1 font-medium text-primary">Default for new projects.</span>
            )}
          </p>
        </div>
        <Separator />
        <div className="space-y-1.5">
          <SectionLabel icon={<ZapIcon className="size-3" />}>Model</SectionLabel>
          <div className="space-y-0.5">
            {MODELS.map((m) => (
              <ModelRow key={m.id} model={m} selected={config.model === m.id} onClick={() => patch({ model: m.id })} />
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
      <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 text-primary" />
          Remembered for <span className="font-medium text-foreground">telar-core</span>
        </span>
        <Switch checked readOnly aria-label="Remember" />
      </div>
    </div>
  );
}
