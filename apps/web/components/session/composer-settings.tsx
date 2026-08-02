"use client";

// 1.2 — collapse the composer's button crowd (permission · model · effort)
// into ONE settings popover fronted by a compact config chip that reads back
// the active model, approval mode and effort at a glance. Ported from the
// owner-verdicted demo (lib/demo-gallery/input/settings-popover.tsx +
// shared.tsx). Provider/account stay as their own pre-session controls in the
// footer; this chip is the config trio.
//
// ONE MENU, BOTH PROVIDERS. This used to be the CLAUDE config trio, and Codex
// got three loose selects beside it instead — approval preset, model, effort —
// so the composer changed shape depending on which agent you picked, and the
// same three decisions were made through two different UIs with two different
// vocabularies. There is no reason for that: the decisions are identical
// (how much may it do on its own · which model · how hard should it think),
// only the option VALUES differ.
//
// So the popover is now provider-neutral and every provider-specific thing
// arrives as data: the approval section takes its own title, options and
// current value (Claude's permission modes, Codex's sandbox+approval presets),
// and the header badge names whichever provider is active. Nothing in this file
// branches on a provider id — if it ever needs to, the abstraction is wrong.
//
// Real data only: the model list is the live catalog fetched by the composer
// (modelOptions), the effort list is the provider's real EFFORT_OPTIONS, and
// the approval options are the provider's real ones — nothing is hardcoded.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  GaugeIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { DEFAULT_MODEL, modelsForProvider, type ModelInfo } from "@/lib/models";
import { getUiPrefs } from "@/lib/ui-prefs";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";

type EffortOpt = { id: string; label: string; blurb: string };

/** One choice in the approval section. Provider-neutral by construction: a
 *  Claude permission mode and a Codex sandbox+approval preset both flatten to
 *  this, which is what lets the two share a control instead of a shape. */
export type ApprovalOption = { value: string; label: string; description: string };

/** Everything the approval section needs, supplied by whoever knows the
 *  provider. `defaultValue` is the one that reads as "Default for new
 *  projects"; `seedValue` (optional) is what a project with no remembered
 *  config should start at, taken from the global Agent-defaults preference.
 *
 *  `seedValue` is a FUNCTION, not a value, so the caller never has to read
 *  localStorage-backed preferences during render — SSR would return the
 *  defaults and the client the stored ones, which is a hydration mismatch
 *  waiting to happen. It is called inside the seed effect, client-side only. */
export type ApprovalConfig = {
  title: string;
  value: string;
  options: readonly ApprovalOption[];
  onChange: (v: string) => void;
  defaultValue: string;
  seedValue?: () => string | undefined;
};

// Icons are positional, not value-keyed: the first option is the permissive
// "just do it" one on both providers, the last is the most cautious. Keying on
// a Claude value here would reintroduce the branch this refactor removed.
const approvalIcon = (index: number, total: number) =>
  index === 0 ? (
    <ZapIcon className="size-3.5 text-primary" />
  ) : index === total - 1 ? (
    <BotIcon className="size-3.5" />
  ) : (
    <CheckIcon className="size-3.5" />
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
  provider,
  open,
  onOpenChange,
  model,
  setModel,
  effort,
  setEffort,
  approval,
  modelOptions,
  effortOptions,
}: {
  project: string;
  provider: "claude" | "codex";
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  approval: ApprovalConfig;
  modelOptions: ModelInfo[];
  effortOptions: EffortOpt[];
}) {
  const [modelQuery, setModelQuery] = useState("");
  // New-session fallback: for a project with NO remembered composer config, seed
  // the still-untouched hardcoded defaults from the global UI preference (see
  // settings › Agent defaults). Per-project memory (telar:composer:<project>)
  // and any explicit choice always win — hence the guards below:
  //   • only when this project has no remembered config yet;
  //   • only while model/permission are still the session's hardcoded defaults
  //     (DEFAULT_MODEL / "auto"), so a resumed session's own values are never
  //     clobbered;
  //   • only for a Claude session (the global model appears in modelOptions),
  //     so a Codex session's model list isn't seeded a Claude id.
  // This effect (a child of the composer) runs before the parent's own seed +
  // persist effects, so it reads the pre-existing memory state correctly.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(`telar:composer:${project}`)) return;
    } catch {
      return;
    }
    const prefs = getUiPrefs();
    if (
      model === DEFAULT_MODEL &&
      modelsForProvider("claude").some((m) => m.id === prefs.defaultModel)
    ) {
      setModel(prefs.defaultModel);
      // Only when the caller supplied one AND the control is still untouched —
      // a resumed session's own choice is never clobbered.
      const seed = approval.seedValue?.();
      if (seed && approval.value === approval.defaultValue) approval.onChange(seed);
    }
    // Seed once per project mount; deliberately not reacting to model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const activeModel = modelOptions.find((m) => m.id === model);
  const modelLabel = activeModel?.name ?? model;
  const active = approval.options.find((o) => o.value === approval.value);
  const approvalLabel = active?.label ?? approval.options[0]?.label ?? "";
  const approvalDescription = active?.description;
  const isDefault = approval.value === approval.defaultValue;
  const effortLabel = effortOptions.find((e) => e.id === effort)?.label;
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return query
      ? modelOptions.filter((option) =>
          `${option.name} ${option.id} ${option.tier}`.toLowerCase().includes(query),
        )
      : modelOptions;
  }, [modelOptions, modelQuery]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button type="button" {...props} className={chipClass(open)}>
            <SparklesIcon className="size-3.5 text-foreground/70" />
            <span className="text-foreground">{modelLabel}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex items-center gap-1">
              {isDefault ? (
                <ZapIcon className="size-3 text-primary" />
              ) : (
                <ShieldCheckIcon className="size-3" />
              )}
              {approvalLabel}
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
            <ProviderIcon provider={provider} size={12} />
            {PROVIDER_LABEL[provider]}
          </Badge>
        </div>

        <div className="max-h-[min(66vh,560px)] space-y-4 overflow-y-auto p-3.5">
          {/* Approval — whatever the provider calls it, in the provider's own
              option set. The control is the same on both. */}
          <div className="space-y-2">
            <SectionLabel icon={<ShieldCheckIcon className="size-3" />}>{approval.title}</SectionLabel>
            <Segmented<string>
              value={approval.value}
              onChange={approval.onChange}
              options={approval.options.map((o, i) => ({
                value: o.value,
                label: o.label,
                icon: approvalIcon(i, approval.options.length),
              }))}
            />
            <p className="px-0.5 text-xs text-muted-foreground">
              {approvalDescription}
              {isDefault && (
                <span className="ml-1 font-medium text-primary">Default for new projects.</span>
              )}
            </p>
          </div>

          <Separator />

          {/* Model list — the live catalog. */}
          <div className="space-y-1.5">
            <SectionLabel icon={<SparklesIcon className="size-3" />}>Model</SectionLabel>
            {modelOptions.length > 6 && (
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder="Search models"
                  aria-label="Search models"
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}
            <div className="space-y-0.5">
              {visibleModels.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={model === m.id}
                  onClick={() => setModel(m.id)}
                />
              ))}
              {visibleModels.length === 0 && (
                <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
                  No models match “{modelQuery}”.
                </p>
              )}
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
