"use client";

import { useState } from "react";
import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AUTO_COMPACT_DEFAULTS, AUTO_COMPACT_MAX_TOKENS, type AutoCompact, type ProviderInstance, type ProviderInstanceEnvVar } from "@telar/engine-client";
import { cn } from "@/ui/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

export function BlurInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (next: string) => void } & Omit<React.ComponentProps<"input">, "value" | "onChange" | "onBlur">) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const SWATCHES = ["#2563eb", "#16a34a", "#ea580c", "#dc2626", "#7c3aed", "#0891b2"] as const;

export function AccentPicker({ value, onChange }: { value?: string; onChange: (next: string | null) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {SWATCHES.map((colour) => (
        <button
          key={colour}
          type="button"
          aria-label={`Accent ${colour}`}
          onClick={() => onChange(colour)}
          style={{ backgroundColor: colour }}
          className={cn(
            "size-5 rounded-full ring-offset-2 ring-offset-background transition",
            value?.toLowerCase() === colour ? "ring-2 ring-ring" : "hover:scale-110",
          )}
        />
      ))}
      <button
        type="button"
        aria-label="No accent"
        onClick={() => onChange(null)}
        className={cn(
          "flex size-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition hover:text-foreground",
          !value && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      >
        <XIcon className="size-2.5" />
      </button>
    </div>
  );
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function publishableEnv(rows: readonly ProviderInstanceEnvVar[]): ProviderInstanceEnvVar[] | null {
  const out: ProviderInstanceEnvVar[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!ENV_NAME.test(name)) {
      if (name === "" && row.value === "" && !row.sensitive) continue;
      return null;
    }
    out.push({ ...row, name });
  }
  return out;
}

export function EnvEditor({ env, onChange }: { env: ProviderInstanceEnvVar[]; onChange: (next: ProviderInstanceEnvVar[]) => void }) {
  const [rows, setRows] = useState<ProviderInstanceEnvVar[]>(env);

  const publish = (next: ProviderInstanceEnvVar[]) => {
    setRows(next);
    const ready = publishableEnv(next);
    if (ready) onChange(ready);
  };

  const patch = (index: number, next: Partial<ProviderInstanceEnvVar>) =>
    publish(rows.map((variable, at) => (at === index ? { ...variable, ...next } : variable)));

  return (
    <div className="space-y-1.5">
      {rows.map((variable, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <BlurInput
            value={variable.name}
            onCommit={(name) => patch(index, { name: name.trim() })}
            placeholder="NAME"
            aria-label={`Variable ${index + 1} name`}
            className="h-7 w-44 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <BlurInput
            key={variable.valueRedacted ? "redacted" : "plain"}
            value={variable.valueRedacted ? "" : variable.value}
            onCommit={(value) => patch(index, { value, valueRedacted: false })}
            type={variable.sensitive ? "password" : "text"}
            placeholder={variable.valueRedacted ? "•••••• stored — type to replace" : "value"}
            aria-label={`Variable ${index + 1} value`}
            className="h-7 flex-1 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <label className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            <input
              type="checkbox"
              checked={variable.sensitive}
              onChange={(event) => patch(index, { sensitive: event.target.checked, valueRedacted: false })}
              className="size-3"
              aria-label={`Store ${variable.name || `variable ${index + 1}`} as a secret`}
            />
            secret
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${variable.name || `variable ${index + 1}`}`}
            onClick={() => publish(rows.filter((_, at) => at !== index))}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground"
        onClick={() => setRows([...rows, { name: "", value: "", sensitive: false }])}
      >
        <PlusIcon className="size-3" /> Add variable
      </Button>
      <p className="text-2xs leading-snug text-muted-foreground/70">
        Applied to this login&rsquo;s provider process, over the worker&rsquo;s own environment. A configured instance also stops
        inheriting the variables its provider owns — an ambient <code className="font-mono">ANTHROPIC_API_KEY</code> would
        otherwise move a subscription account onto metered billing without saying so.
      </p>
    </div>
  );
}

type CompactionMode = "default" | AutoCompact["mode"];

const COMPACTION_MODES: { value: CompactionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "limits", label: "Compact after…" },
  { value: "never", label: "Never compact" },
];

const COMPACTION_CLASSES = [
  { key: "standard", label: "200k models" },
  { key: "long", label: "1M models" },
] as const;

const COMPACTION_INFO: Record<ProviderInstance["driver"], string> = {
  claude: "A limit past a model's own ceiling — its window less 33,000 tokens — compacts at that ceiling instead.",
  codex: "Codex has no switch that turns auto-compaction off, so Never leaves Codex's own behaviour. Its long window is 872k.",
  opencode:
    "Applies to sessions that name their model, since the provider's default model has no window to read. A limit only ever brings compaction earlier.",
};

export function compactionEdit(
  current: Extract<AutoCompact, { mode: "limits" }>,
  which: "standard" | "long",
  typed: string,
): { autoCompact: AutoCompact } | { refused: string } {
  const digits = typed.replace(/[,\s_]/g, "");
  const wanted = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > AUTO_COMPACT_MAX_TOKENS) {
    return { refused: `A whole number of tokens from 1 to ${AUTO_COMPACT_MAX_TOKENS.toLocaleString("en-US")}.` };
  }
  return { autoCompact: { ...current, [which]: wanted } };
}

export function CompactionField({
  driver,
  value,
  onChange,
}: {
  driver: ProviderInstance["driver"];
  value: AutoCompact | undefined;
  onChange: (next: AutoCompact | null) => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const mode: CompactionMode = value?.mode ?? "default";

  const select = (next: CompactionMode): void => {
    setRefused(null);
    if (next === "default") onChange(null);
    else if (next === "never") onChange({ mode: "never" });
    else onChange(value?.mode === "limits" ? value : { mode: "limits", ...AUTO_COMPACT_DEFAULTS });
  };

  return (
    <div>
      <span className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-foreground">Auto-compaction</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="More about auto-compaction"
                data-info={COMPACTION_INFO[driver]}
                className="flex shrink-0 items-center text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <InfoIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipContent side="top" className="max-w-72 text-xs leading-snug">
            {COMPACTION_INFO[driver]}
          </TooltipContent>
        </Tooltip>
      </span>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Auto-compaction">
        {COMPACTION_MODES.map((option) => {
          const on = mode === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              variant={on ? "secondary" : "ghost"}
              size="sm"
              className={cn("h-7 px-2 text-xs", on ? "text-foreground" : "text-muted-foreground")}
              onClick={() => select(option.value)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {value?.mode === "limits" && (
        <div className="mt-1.5 flex flex-col gap-1">
          {COMPACTION_CLASSES.map((entry) => (
            <label key={entry.key} className="flex items-center gap-1.5">
              <span className="w-20 text-2xs text-muted-foreground">{entry.label}</span>
              <BlurInput
                key={value[entry.key]}
                value={value[entry.key].toLocaleString("en-US")}
                onCommit={(typed) => {
                  const edit = compactionEdit(value, entry.key, typed);
                  if ("refused" in edit) {
                    setRefused(edit.refused);
                    return;
                  }
                  setRefused(null);
                  onChange(edit.autoCompact);
                }}
                aria-label={`Compact ${entry.label} after how many tokens`}
                inputMode="numeric"
                className="h-7 w-28 text-right font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="text-2xs text-muted-foreground">tokens</span>
            </label>
          ))}
        </div>
      )}
      {refused && <p className="mt-1 text-2xs leading-snug text-destructive">{refused}</p>}
      <p className="mt-1 text-2xs leading-snug text-muted-foreground">
        {mode === "default"
          ? "The provider decides when a session compacts."
          : mode === "never"
            ? "A session grows until the model refuses the prompt; compacting by hand still works."
            : "A session compacts once its conversation reaches the limit for its model's context window."}
      </p>
    </div>
  );
}
