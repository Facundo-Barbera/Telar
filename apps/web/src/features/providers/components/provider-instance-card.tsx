"use client";

import { useState } from "react";
import { ArrowUpCircleIcon, ChevronDownIcon, DownloadIcon, InfoIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AUTO_COMPACT_DEFAULTS,
  AUTO_COMPACT_MAX_TOKENS,
  type AutoCompact,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
  type ProviderProbe,
} from "@telar/engine-client";
import { cn } from "@/lib/utils";
import { normaliseContextNoticePercent } from "@/lib/context-notice";
import { displayNameOf, DRIVER_LABEL, isDefaultInstance, providerSummary, STATUS_DOT, STATUS_LABEL, updateAdvisory, versionLabel } from "../provider-instances";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Tabs } from "@/components/settings/settings-shell";
import { ProviderModelsTab } from "./provider-models-tab";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon } from "./provider-icon";
import { CopyCommand } from "@/components/ui/copy-command";

type ProviderTab = "configuration" | "models";

export type InstancePatch = {
  displayName?: string | null;
  accentColor?: string | null;
  contextNoticePercent?: number | null;
  autoCompact?: AutoCompact | null;
  configDir?: string | null;
  binaryPath?: string | null;
  enabled?: boolean;
  env?: ProviderInstanceEnvVar[];
};

function BlurInput({
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

function AccentPicker({ value, onChange }: { value?: string; onChange: (next: string | null) => void }) {
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

function EnvEditor({ env, onChange }: { env: ProviderInstanceEnvVar[]; onChange: (next: ProviderInstanceEnvVar[]) => void }) {
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

function CompactionField({
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

export type InheritanceNotice = {
  names: readonly string[];
  onCarryOver: () => void;
  onDismiss: () => void;
};

function InheritanceNotice({ driver, names, onCarryOver, onDismiss }: InheritanceNotice & { driver: ProviderInstance["driver"] }) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3" role="status">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          This login has stopped inheriting {names.length === 1 ? "a variable" : `${names.length} variables`} from Telar
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon className="size-3" />
        </Button>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        Configuring a login stops it picking up {DRIVER_LABEL[driver]}&rsquo;s own variables from the environment Telar was
        launched with — otherwise an ambient key or proxy would silently replace this login&rsquo;s identity. Telar was passing
        {names.length === 1 ? " this one" : " these"} down, and no longer will:
      </p>
      <ul className="flex flex-wrap gap-1">
        {names.map((name) => (
          <li key={name}>
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-3xs text-foreground">{name}</code>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pt-0.5">
        <Button size="sm" className="h-7 px-2 text-xs" onClick={onCarryOver}>
          Keep {names.length === 1 ? "it" : "them"} for this login
        </Button>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground/70">
        Keeping {names.length === 1 ? "it" : "them"} copies the current value into this login&rsquo;s own environment below, where
        it survives. The value is read by the engine and never shown here; a credential is stored as a secret. If this login is
        meant to have its own identity, dismiss this instead.
      </p>
    </div>
  );
}

export function ProviderInstanceCard({
  instance,
  probe,
  signInCommand,
  expanded,
  onExpandedChange,
  onPatch,
  onRemove,
  onUpdateCli,
  updating,
  error,
  inheritance,
}: {
  instance: ProviderInstance;
  probe?: ProviderProbe;
  signInCommand: string;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onPatch: (patch: InstancePatch) => void;
  onUpdateCli?: () => void;
  updating?: boolean;
  onRemove?: () => void;
  error?: string | null;
  inheritance?: InheritanceNotice;
}) {
  const [tab, setTab] = useState<ProviderTab>("configuration");
  const title = displayNameOf(instance);
  const status = probe?.status ?? (instance.enabled ? "warning" : "disabled");
  const summary = providerSummary(probe);
  const version = versionLabel(probe?.version);
  const isDefault = isDefaultInstance(instance);
  const needsSignIn = probe?.signIn === "signed-out" || probe?.signIn === "missing-config-dir";
  const advisory = updateAdvisory(probe, DRIVER_LABEL[instance.driver]);

  return (
    <div className={cn("rounded-xl transition-colors hover:bg-muted/20", !instance.enabled && "opacity-60")}>
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                <span
                  className="flex size-5 items-center justify-center rounded-[5px] ring-1 ring-inset ring-border/60"
                  style={
                    instance.accentColor
                      ? {
                          backgroundColor: `color-mix(in srgb, ${instance.accentColor} 22%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${instance.accentColor} 55%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <ProviderIcon provider={instance.driver} size={13} />
                </span>
                <span
                  title={STATUS_LABEL[status]}
                  aria-label={`Status: ${STATUS_LABEL[status]}`}
                  className={cn("pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card", STATUS_DOT[status])}
                />
              </span>
              <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
              {title !== instance.id && (
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">{instance.id}</code>
              )}
              {version && <code className="text-xs text-muted-foreground">{version}</code>}
              {advisory && (
                <button
                  type="button"
                  onClick={() => onExpandedChange(true)}
                  title={advisory.headline}
                  aria-label={`${advisory.headline} — ${title}`}
                  className="inline-flex items-center rounded-sm text-warning transition-opacity hover:opacity-80"
                >
                  <ArrowUpCircleIcon className="size-3.5" />
                </button>
              )}
              {isDefault && (
                <Badge variant="outline" className="text-3xs" title="The provider's base login, detected rather than added">
                  built-in
                </Badge>
              )}
              {summary && (
                <Badge variant={status === "error" ? "destructive" : "outline"} className="text-3xs">
                  {summary}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-1 sm:w-auto sm:justify-end">
            {onRemove && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-destructive"
                title="Forget how this login was configured. Its login on disk is left untouched, and sessions fall back to the built-in slot."
                onClick={onRemove}
                aria-label={`Remove ${title}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onExpandedChange(!expanded)}
              aria-label={`Toggle ${title} details`}
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            </Button>
            <Switch
              className="ml-1"
              checked={instance.enabled}
              onCheckedChange={(checked) => onPatch({ enabled: Boolean(checked) })}
              aria-label={`Enable ${title}`}
            />
          </div>
        </div>
      </div>

      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-4 px-3 pb-4 pt-1 sm:px-4">
            {inheritance && <InheritanceNotice driver={instance.driver} {...inheritance} />}
            <Tabs<ProviderTab>
              value={tab}
              onChange={setTab}
              options={[
                { value: "configuration", label: "Configuration" },
                { value: "models", label: "Models" },
              ]}
            />
            {tab === "models" && <ProviderModelsTab instance={instance} />}
            {tab === "configuration" && (
            <div className="space-y-4">
            {advisory && (
              <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{advisory.headline}</span>
                  {advisory.command && onUpdateCli && (
                    <Button size="sm" className="h-7 px-2 text-xs" disabled={updating} onClick={onUpdateCli}>
                      {updating ? <Spinner /> : <DownloadIcon className="size-3.5" />}
                      {updating ? "Updating" : "Update now"}
                    </Button>
                  )}
                </div>
                <p className="text-2xs leading-snug text-muted-foreground">{advisory.detail}</p>
                {advisory.command && (
                  <>
                    <CopyCommand command={advisory.command} />
                    <p className="text-2xs leading-snug text-muted-foreground/70">
                      Telar picked this from how the CLI was installed, and runs exactly it. Any other login of{" "}
                      {DRIVER_LABEL[instance.driver]} pointing at the same binary moves with it.
                    </p>
                  </>
                )}
              </div>
            )}

            {needsSignIn && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">Sign in</span>
                <CopyCommand command={signInCommand} />
                <p className="text-2xs text-muted-foreground/70">
                  Run this in your terminal. Telar reads the result — it never signs in for you.
                </p>
              </div>
            )}

            <label className="block">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <BlurInput
                value={instance.displayName ?? ""}
                onCommit={(next) => onPatch({ displayName: next.trim() || null })}
                placeholder={title}
                className="mt-1.5 h-8 text-xs"
              />
              <span className="mt-1 block text-2xs text-muted-foreground">
                Shown in the pickers. The routing key ({instance.id}) never changes.
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-foreground">Accent colour</span>
              <div className="mt-1.5">
                <AccentPicker {...(instance.accentColor ? { value: instance.accentColor } : {})} onChange={(accentColor) => onPatch({ accentColor })} />
              </div>
              <span className="mt-1 block text-2xs text-muted-foreground">Tells this login apart from another on the same provider.</span>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-foreground">Heavy context notice</span>
              <span className="mt-1.5 flex items-center gap-1.5">
                <BlurInput
                  key={normaliseContextNoticePercent(instance.contextNoticePercent)}
                  value={String(normaliseContextNoticePercent(instance.contextNoticePercent))}
                  onCommit={(next) => {
                    const typed = next.trim();
                    if (!typed) {
                      onPatch({ contextNoticePercent: null });
                      return;
                    }
                    const wanted = Number(typed);
                    if (Number.isFinite(wanted)) onPatch({ contextNoticePercent: wanted });
                  }}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  aria-label="Heavy context notice"
                  className="h-8 w-20 text-right font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="text-2xs text-muted-foreground">% of the model&rsquo;s context window</span>
              </span>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground">
                {instance.driver === "opencode" ? "OpenCode config folder (shared CLI login)" : instance.driver === "codex" ? "CODEX_HOME folder" : "CLAUDE_CONFIG_DIR folder"}
              </span>
              {isDefault ? (
                <p className="mt-1.5 text-2xs text-muted-foreground">
                  {instance.driver === "opencode" ? "Uses the native OpenCode CLI login. A config folder does not isolate credentials." : "Empty — this is the base login. Telar leaves the config variable unset to preserve its credential store."}
                </p>
              ) : (
                <>
                  <BlurInput
                    value={instance.configDir ?? ""}
                    onCommit={(next) => onPatch({ configDir: next.trim() || null })}
                    placeholder="~/.claude-work"
                    className="mt-1.5 h-8 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="mt-1 block text-2xs text-muted-foreground">
                    The folder this login is already signed in with. It must already exist.
                  </span>
                </>
              )}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground">Binary path</span>
              <BlurInput
                value={instance.binaryPath ?? ""}
                onCommit={(next) => onPatch({ binaryPath: next.trim() || null })}
                placeholder={instance.driver}
                className="mt-1.5 h-8 font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="mt-1 block text-2xs text-muted-foreground">
                Empty uses <code className="font-mono">{instance.driver}</code> as your shell would resolve it. A bare name looks that
                name up on PATH; a full path runs exactly that file. Beats{" "}
                <code className="font-mono">{instance.driver === "opencode" ? "OPENCODE_BIN" : instance.driver === "codex" ? "CODEX_BIN" : "CLAUDE_CODE_EXECUTABLE"}</code> when both are
                set.
              </span>
            </label>

            <CompactionField driver={instance.driver} value={instance.autoCompact} onChange={(autoCompact) => onPatch({ autoCompact })} />

            <div>
              <span className="text-xs font-medium text-foreground">Environment variables</span>
              <div className="mt-1.5">
                <EnvEditor key={instance.updatedAt} env={instance.env} onChange={(env) => onPatch({ env })} />
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
