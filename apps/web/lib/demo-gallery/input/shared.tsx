"use client";

// Shared vocabulary for the input-lane demos (concerns 1.2 + 1.5). Mirrors the
// real composer's option sets (lib/models.ts EFFORT_OPTIONS / MODELS,
// session-view PERMISSION_MODE_OPTIONS, lib/permissions ClientPermissionMode)
// so the redesign reads in the same language the user sees in production.
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  GaugeIcon,
  SparklesIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";

export type PermMode = "default" | "auto" | "acceptEdits";

export const PERM_MODES: {
  value: PermMode;
  label: string;
  description: string;
}[] = [
  {
    value: "default",
    label: "Ask me",
    description: "Prompt for every tool call that isn't already allowed.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "A classifier approves routine tool calls automatically.",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    description: "Auto-accept file edits; still ask about everything else.",
  },
];

export type ModelOpt = {
  id: string;
  name: string;
  context: string;
  blurb: string;
};

export const MODELS: ModelOpt[] = [
  { id: "claude-fable-5", name: "Fable 5", context: "1M", blurb: "Deepest reasoning. Best for hard, ambiguous work." },
  { id: "claude-opus-4-8", name: "Opus 4.8", context: "1M", blurb: "Frontier quality for complex multi-file changes." },
  { id: "claude-sonnet-5", name: "Sonnet 5", context: "1M", blurb: "Balanced everyday default — fast and capable." },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", context: "200K", blurb: "Fastest and cheapest for routine turns." },
];

export type EffortOpt = { id: string; label: string; blurb: string };

export const EFFORTS: EffortOpt[] = [
  { id: "default", label: "Auto", blurb: "Let the model choose its own effort." },
  { id: "low", label: "Low", blurb: "Fastest, least reasoning." },
  { id: "medium", label: "Medium", blurb: "Balanced everyday reasoning." },
  { id: "high", label: "High", blurb: "Deep reasoning for harder problems." },
  { id: "max", label: "Max", blurb: "Maximum reasoning. Model-dependent." },
];

export type Config = {
  provider: "claude";
  model: string;
  effort: string;
  perm: PermMode;
};

// Auto Mode is the DEFAULT (brief 1.2): a brand-new project starts here.
export const DEFAULT_CONFIG: Config = {
  provider: "claude",
  model: "claude-sonnet-5",
  effort: "default",
  perm: "auto",
};

export const modelName = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id;
export const effortLabel = (id: string) => EFFORTS.find((e) => e.id === id)?.label ?? id;
export const permLabel = (v: PermMode) => PERM_MODES.find((p) => p.value === v)?.label ?? v;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

// The collapsed-bar chip: one glance = the whole active config. Replaces the
// row of 4–5 selects (provider · account · permission · model · effort) that
// crowd the production footer. Split into a class + content pair so it can back
// a Base UI Popover trigger via the render-function form (which spreads the
// trigger's props/ref onto our button — a wrapper button would swallow them).
export function chipClass(active?: boolean) {
  return cn(
    "flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors",
    "hover:bg-accent hover:text-foreground",
    active && "border-ring bg-accent text-foreground",
  );
}

export function ChipContent({ config }: { config: Config }) {
  const auto = config.perm === "auto";
  return (
    <>
      <SparklesIcon className="size-3.5 text-foreground/70" />
      <span className="text-foreground">{modelName(config.model)}</span>
      <span className="text-muted-foreground/40">·</span>
      <span className="flex items-center gap-1">
        {auto ? (
          <ZapIcon className="size-3 text-primary" />
        ) : (
          <ShieldCheckIcon className="size-3" />
        )}
        {permLabel(config.perm)}
      </span>
      {config.effort !== "default" && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span>{effortLabel(config.effort)}</span>
        </>
      )}
    </>
  );
}

// A labelled segmented control — the interaction the popover uses for
// permissions and effort (single-tap, no dropdown-inside-a-dropdown).
export function Segmented<T extends string>({
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
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

// A model row inside the popover's model list.
export function ModelRow({
  model,
  selected,
  onClick,
}: {
  model: ModelOpt;
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

export const PERM_ICONS = {
  default: <BotIcon className="size-3.5" />,
  auto: <ZapIcon className="size-3.5" />,
  acceptEdits: <CheckIcon className="size-3.5" />,
} as const;

export { GaugeIcon };
