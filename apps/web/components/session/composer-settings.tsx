"use client";

// THE ONE AGENT-CONFIGURATION MENU. Access · model · whatever else the provider
// publishes, in a single popover fronted by a chip that reads the session's
// posture back at a glance.
//
// NOTHING IN THIS FILE KNOWS WHICH HARNESS IS DRIVING. The previous version
// said the same thing and was only half true: it took the approval section's
// options as data, but it still drew their icons by ARRAY POSITION, and the two
// providers handed it lists of different lengths ordered on different
// principles. Position is not a property of a permission; the result was the
// most cautious mode on Claude wearing the accent-coloured lightning bolt and
// Codex's `danger-full-access` wearing a checked shield. Icons are now keyed by
// the mode's own value through ACCESS_GLYPH below, which is a Record over
// RuntimeMode — so reordering the ladder cannot move a glyph, and adding a rung
// fails the build until someone decides what it looks like.
//
// The remaining sections are generic by construction. The provider publishes
// `ProviderOptionGroup`s (lib/provider-options.ts) and this renders whatever it
// finds, in order, with one loop — Claude's Reasoning group and a future Codex
// Service Tier group are the same code path. A provider that publishes nothing
// gets no section and no separator, because an empty menu is a worse answer
// than a shorter one.

import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import {
  CheckIcon,
  FilePenIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { profileRuntimeModeCeiling, type RuntimeMode } from "@telar/core/runtime-mode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { DEFAULT_MODEL, type ModelInfo } from "@/lib/models";
import { groupDefault, triggerLabel, type ProviderOptionGroup } from "@/lib/provider-options";
import { getUiPrefs } from "@/lib/ui-prefs";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";

/** One rung of the access ladder, in `RUNTIME_MODE_OPTIONS`' own publication
 *  order and its own words. Passed in rather than imported so the caller owns
 *  WHICH rungs this build lets a client select (see SELECTABLE_RUNTIME_MODES)
 *  and this file owns only how they look. */
export type AccessOption = {
  value: RuntimeMode;
  label: string;
  description: string;
};

/** Everything the access section needs. `seedValue` is a FUNCTION, not a value,
 *  so the caller never reads localStorage-backed preferences during render —
 *  SSR would return the defaults and the client the stored ones, which is a
 *  hydration mismatch waiting to happen. It is called inside the seed effect,
 *  client-side only. */
export type AccessConfig = {
  value: RuntimeMode;
  options: readonly AccessOption[];
  onChange: (v: RuntimeMode) => void;
  /** The rung a brand-new session starts on. Marks its row and guards the seed
   *  below: a session already sitting somewhere else has been configured, and a
   *  preference must never move it. */
  defaultValue: RuntimeMode;
  seedValue?: () => RuntimeMode | undefined;
  /** The most permissive rung THIS SESSION KIND may reach, whatever the user
   *  picks — the same `runtimeModeCeiling(kind)` the chat route applies before
   *  the turn runs. Rungs above it render disabled with `ceilingReason` in
   *  place of their description, because the alternative is a live button that
   *  moves and changes nothing. Absent means no cap. */
  ceiling?: RuntimeMode;
  ceilingReason?: string;
};

// VALUE-KEYED, EXHAUSTIVE, AND THAT IS THE POINT. A `Record<RuntimeMode, …>`
// cannot be satisfied by three entries, so a fifth mode arriving in core is a
// type error here rather than a silently-wrong glyph — which is precisely how
// the positional version failed.
//
// The tone ladder says one thing and one thing only: how much runs unattended.
// `--warning` is spent on `full-access` alone because that is the single rung
// where no tool call stops to ask (`promptsForApproval` returns false there on
// both harnesses, and only there). `--info` marks the rung where a reviewer is
// in the loop rather than the human, which is Auto's own description. The two
// most cautious rungs stay muted on purpose: an alarm colour on the safest
// choice is the bug this control was rebuilt to remove.
//
// EXPORTED so settings › Agent defaults draws the same rung with the same
// glyph. Two surfaces showing the same permission state under different icons
// (and different words) is what the shared vocabulary exists to stop, and a map
// each pane keeps privately is how they drift apart again.
export const ACCESS_GLYPH: Record<
  RuntimeMode,
  { Icon: ComponentType<{ className?: string }>; tone: string }
> = {
  "approval-required": { Icon: ShieldCheckIcon, tone: "text-muted-foreground" },
  "auto-accept-edits": { Icon: FilePenIcon, tone: "text-muted-foreground" },
  auto: { Icon: ZapIcon, tone: "text-info" },
  "full-access": { Icon: ShieldOffIcon, tone: "text-warning" },
};

function chipClass(active: boolean) {
  return cn(
    "flex h-8 items-center gap-2 rounded-control border border-input bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors",
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

// STACKED ROWS, NOT A SEGMENTED STRIP. The strip gave each option an equal
// fraction of a 340px popover and then truncated: Codex's four labels rendered
// as "Read…", "Appro…", "Ask f…", "Full …", leaving the (wrong) icons as the
// only way to tell them apart. A permission control whose labels you cannot
// read is worse than no control. Three rungs render today and the vocabulary
// holds four, but the count is not the argument: at three the strip is still
// wrong, because "Auto-accept edits" does not fit a third of a 340px popover
// either. A row gets the full column width, its whole label, and its own
// one-line description, and that holds at any length.
function OptionRow({
  icon,
  title,
  badge,
  subtitle,
  selected,
  disabled,
  onClick,
}: {
  icon?: ReactNode;
  title: string;
  badge?: ReactNode;
  subtitle?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
        // Not hidden. A rung this session cannot have is still information
        // about the session, and a list that silently gets shorter reads as a
        // different product rather than as a restricted one.
        disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
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
          {icon}
          <span className="text-sm font-medium">{title}</span>
          {badge}
        </span>
        {subtitle && (
          <span className="mt-0.5 block text-xs text-muted-foreground">{subtitle}</span>
        )}
      </span>
    </button>
  );
}

// One published group, whatever it is. The chips wrap rather than divide the
// width, so a group of six values costs a second line instead of six ellipses.
function GroupSection({
  group,
  value,
  onChange,
}: {
  group: ProviderOptionGroup;
  value: string;
  onChange: (v: string) => void;
}) {
  const active = group.values.find((v) => v.value === value);
  return (
    <div className="space-y-2">
      <SectionLabel icon={<SlidersHorizontalIcon className="size-3" />}>
        {group.label}
      </SectionLabel>
      <div className="flex flex-wrap gap-1 rounded-control bg-muted/60 p-1">
        {group.values.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() => onChange(v.value)}
            className={cn(
              "rounded-control px-2 py-1.5 text-xs font-medium transition-colors",
              value === v.value
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      {active?.blurb && <p className="px-0.5 text-xs text-muted-foreground">{active.blurb}</p>}
    </div>
  );
}

export function ComposerSettings({
  project,
  provider,
  open,
  onOpenChange,
  model,
  setModel,
  modelOptions,
  access,
  groups,
  values,
  onValueChange,
}: {
  project: string;
  provider: "claude" | "codex";
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string;
  setModel: (v: string) => void;
  modelOptions: ModelInfo[];
  access: AccessConfig;
  /** What this provider publishes about itself, in publication order. */
  groups: readonly ProviderOptionGroup[];
  /** Current value per group id; a missing entry reads as the group's default. */
  values: Readonly<Record<string, string>>;
  onValueChange: (groupId: string, value: string) => void;
}) {
  // New-session fallback: for a project with NO remembered composer config, seed
  // the still-untouched hardcoded defaults from the global UI preference (see
  // settings › Agent defaults). Per-project memory (telar:composer:<project>)
  // and any explicit choice always win — hence the guards below:
  //   • only when this project has no remembered config yet;
  //   • only while the control is still on the value a fresh session starts at,
  //     so a resumed session's own choice is never clobbered.
  // The ACCESS seed is no longer nested inside the model gate the way the old
  // approval seed was: that nesting was how "only Claude seeds a posture"
  // was expressed, and posture is not a per-provider question any more.
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
    if (model === DEFAULT_MODEL && modelOptions.some((m) => m.id === prefs.defaultModel)) {
      setModel(prefs.defaultModel);
    }
    const seed = access.seedValue?.();
    if (seed && access.value === access.defaultValue) access.onChange(seed);
    // Seed once per project mount; deliberately not reacting to model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const modelLabel = modelOptions.find((m) => m.id === model)?.name ?? model;
  const accessLabel = access.options.find((o) => o.value === access.value)?.label ?? access.value;
  // TOTAL, not merely exhaustive. `Record<RuntimeMode, …>` is a compile-time
  // guarantee and this is indexed with a value that reached us from disk (a
  // chats.json row) — a hand-edited "plan" there would destructure `undefined`
  // and take the whole session view down. The store caps what it reads; this is
  // the second half of the same belt.
  const accessGlyph = ACCESS_GLYPH[access.value] ?? ACCESS_GLYPH[access.options[0]!.value];
  const { Icon: AccessIcon, tone: accessTone } = accessGlyph;
  // The rest of the chip is whatever the provider publishes that is NOT on its
  // default — triggerLabel() stays quiet until something is actually set, so
  // the bar reads "<model> · Auto" most of the time and grows a third term only
  // once a session asks for one.
  const published = triggerLabel(groups, values);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button type="button" {...props} className={chipClass(open)}>
            <SparklesIcon className="size-3.5 text-foreground/70" />
            <span className="text-foreground">{modelLabel}</span>
            <span className="text-muted-foreground/40">·</span>
            {/* Access is the one value the chip states unconditionally, default
                or not. Every other control is quiet at rest; how much the agent
                may do without asking is not a detail you should have to open a
                menu to recover. */}
            <span className="flex items-center gap-1">
              <AccessIcon className={cn("size-3", accessTone)} />
              {accessLabel}
            </span>
            {published && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{published}</span>
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
          {/* ACCESS — the same rungs, in the same words, on every harness.
              Rendered in the order core publishes them, which is
              least-permissive first: a list that opens on its most permissive
              entry teaches the wrong reflex before a single label is read. */}
          <div className="space-y-1.5">
            <SectionLabel icon={<ShieldCheckIcon className="size-3" />}>Access</SectionLabel>
            <div className="space-y-0.5">
              {access.options.map((o) => {
                const { Icon, tone } = ACCESS_GLYPH[o.value] ?? ACCESS_GLYPH["approval-required"];
                // Above this session kind's ceiling — the route would cap it
                // anyway, so the row says so instead of accepting a click and
                // letting the server quietly disagree. Asked through core's own
                // comparator rather than by comparing positions in this list:
                // the ceiling can legitimately be a mode this build does not
                // offer (`full-access`), which no index into `options` can
                // express.
                const capped =
                  access.ceiling !== undefined &&
                  profileRuntimeModeCeiling(o.value, access.ceiling) !== o.value;
                return (
                  <OptionRow
                    key={o.value}
                    icon={<Icon className={cn("size-3.5", tone)} />}
                    title={o.label}
                    badge={
                      o.value === access.defaultValue ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          default
                        </span>
                      ) : undefined
                    }
                    subtitle={capped ? (access.ceilingReason ?? o.description) : o.description}
                    selected={access.value === o.value}
                    disabled={capped}
                    onClick={() => access.onChange(o.value)}
                  />
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Model list — the live catalog. */}
          <div className="space-y-1.5">
            <SectionLabel icon={<SparklesIcon className="size-3" />}>Model</SectionLabel>
            <div className="space-y-0.5">
              {modelOptions.map((m) => (
                <OptionRow
                  key={m.id}
                  title={m.name}
                  badge={
                    <span className="rounded border border-border px-1 py-0 text-[10px] text-muted-foreground">
                      {m.context}
                    </span>
                  }
                  subtitle={m.blurb}
                  selected={model === m.id}
                  onClick={() => setModel(m.id)}
                />
              ))}
            </div>
          </div>

          {/* Whatever else this provider publishes. No section, and no
              separator above it, when the answer is nothing — an empty menu
              reads as a broken one. */}
          {groups.map((g) => (
            <div key={g.id} className="space-y-4">
              <Separator />
              <GroupSection
                group={g}
                value={values[g.id] ?? groupDefault(g)}
                onChange={(v) => onValueChange(g.id, v)}
              />
            </div>
          ))}
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
