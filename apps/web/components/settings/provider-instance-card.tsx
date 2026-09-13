"use client";

/**
 * ONE CONFIGURED LOGIN, as a card.
 *
 * Ported from t3 code's `src/components/settings/ProviderInstanceCard.tsx` —
 * which is also what `apps/web_old`'s `provider-instances.tsx` was modelled on,
 * so this is the same design arriving from both directions. The shape it wants:
 * an account is not a separate concept from "a provider you configured", it IS
 * a configured instance of one. So there is no Providers list beside an Accounts
 * list; the first row for a driver is its built-in slot and every extra row is
 * another login of the same driver.
 *
 * COLLAPSED, A ROW STATES WHAT IT IS AND WHETHER IT WORKS. Expanded, it holds
 * everything that makes it that account: the name, the accent, the config
 * folder, and the environment its provider process runs with.
 *
 * NOTHING HERE SIGNS ANYONE IN. A row that cannot prove a login shows the
 * command to run in a terminal, and that is the whole of Telar's involvement in
 * auth — the engine reads no credential file (apps/engine/src/provider-instances.ts).
 *
 * TWO DEVIATIONS FROM t3, EACH BECAUSE THE ENGINE CANNOT BACK IT:
 *   · No identity line. t3 prints "Authenticated as <email> · Claude Max"; this
 *     engine holds no identity, so the auth line says what was measured.
 *   · The identity line is the only one left. There WAS a second — "no models
 *     section" — and the Models tab is that decision reversed. What has not
 *     changed is the reason it was written: every row in that tab still comes
 *     from ASKING the harness (apps/engine/src/models.ts). The tab stores only
 *     what this login's reader did to that answer — starred, hidden, and the
 *     ids they typed because the CLI does not publish them yet. t3's tab lists
 *     a catalogue this app still refuses to keep.
 *
 * THE UPDATE ADVISORY IS A FACT ABOUT THE BINARY, not about this login. Every
 * row for a driver shows the same one and updating from any of them updates all
 * of them — the same way the version beside the name already behaves.
 */

import { useState } from "react";
import { ArrowUpCircleIcon, ChevronDownIcon, DownloadIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ProviderInstance, ProviderInstanceEnvVar, ProviderProbe } from "@telar/engine-client";
import { cn } from "@/lib/utils";
import { displayNameOf, DRIVER_LABEL, isDefaultInstance, providerSummary, STATUS_DOT, STATUS_LABEL, updateAdvisory, versionLabel } from "@/lib/provider-instances";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Tabs } from "@/components/settings/settings-shell";
import { ProviderModelsTab } from "@/components/settings/provider-models-tab";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon } from "@/components/session/provider-icon";
import { CopyCommand } from "@/components/settings/copy-command";

type ProviderTab = "configuration" | "models";

/** What a save may carry. */
export type InstancePatch = {
  displayName?: string | null;
  accentColor?: string | null;
  configDir?: string | null;
  binaryPath?: string | null;
  enabled?: boolean;
  env?: ProviderInstanceEnvVar[];
};

/**
 * An input that reports on BLUR, not on every keystroke.
 *
 * Every commit here is an HTTP write. A controlled input wired straight to
 * `onPatch` would PUT once per character, and the last few would race each
 * other. Uncontrolled with a `key` derived from the stored value, so an edit
 * rejected by the engine snaps back to what was actually kept rather than
 * lingering on screen as if it had saved.
 */
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
        // Escape abandons the edit rather than committing it, which is the one
        // way out of a half-typed path that does not write anything.
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The accent, as six swatches and a clear.
 *
 * IT TINTS THE MARK RATHER THAN FILLING IT. Both provider marks carry their own
 * colour — Claude's #d97757, Codex's currentColor — and painting a user-chosen
 * background behind them turned a brand mark into a swatch. As a soft wash plus
 * a ring it still tells two logins of one provider apart, which is its job.
 */
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

/** The shell's own rule, mirrored from the contract so a name that cannot be
 *  exported is refused here rather than round-tripped to a 400. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Which of these draft rows are worth sending.
 *
 * A HALF-TYPED ROW IS NOT A CHANGE. Adding a variable puts an empty row on
 * screen, and publishing that immediately is what this used to do — the engine
 * refused the empty name and the card showed "provider instance environment is
 * invalid" before the user had typed a character. Found by pressing the button,
 * not by a test.
 *
 * So: a wholly empty row is DROPPED (it is a row somebody is about to fill in),
 * a row with a name that is not a legal variable name SUSPENDS the publish
 * entirely (mid-typing, and sending the rest would silently delete the row
 * being edited), and everything else goes.
 */
export function publishableEnv(rows: readonly ProviderInstanceEnvVar[]): ProviderInstanceEnvVar[] | null {
  const out: ProviderInstanceEnvVar[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!ENV_NAME.test(name)) {
      // Empty and untouched: nothing to say about it yet. Anything else means
      // the user is mid-edit, and the whole list waits for them.
      if (name === "" && row.value === "" && !row.sensitive) continue;
      return null;
    }
    out.push({ ...row, name });
  }
  return out;
}

/**
 * The environment this instance's provider process runs with.
 *
 * A SENSITIVE VALUE NEVER COMES BACK FROM THE ENGINE. The placeholder says so,
 * and leaving the field empty keeps whatever is stored — which is why clearing
 * a secret means removing the row, not blanking it. A blank field is
 * indistinguishable from "I did not retype my key".
 *
 * THE ROWS ARE LOCAL, and the parent re-keys this editor whenever the SERVER's
 * copy changes, so a saved edit reseeds from what was actually kept. Without a
 * local draft there is nowhere for a row to exist between "add" and "named".
 */
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
            // Keyed so replacing a secret and then blurring shows the stored
            // placeholder again rather than the value just sent.
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
          <label className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
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
        // Local only, on purpose: an empty row is not a change, and
        // publishing one is what produced "environment is invalid" before the
        // user had typed a character.
        onClick={() => setRows([...rows, { name: "", value: "", sensitive: false }])}
      >
        <PlusIcon className="size-3" /> Add variable
      </Button>
      <p className="text-[0.6875rem] leading-snug text-muted-foreground/70">
        Applied to this login&rsquo;s provider process, over the worker&rsquo;s own environment. A configured instance also stops
        inheriting the variables its provider owns — an ambient <code className="font-mono">ANTHROPIC_API_KEY</code> would
        otherwise move a subscription account onto metered billing without saying so.
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
}: {
  instance: ProviderInstance;
  probe?: ProviderProbe;
  /** What the user would run in their own terminal to sign this login in. */
  signInCommand: string;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onPatch: (patch: InstancePatch) => void;
  /** Runs the update the engine derived. Absent when the caller has no way to,
   *  which is also how a `pinned` advisory renders without a button — the
   *  engine sends no command in that state and the rule stays in one place. */
  onUpdateCli?: () => void;
  /** An update that touches THIS ROW'S BINARY is running. Set on every row
   *  resolving to the same executable, since they do all change together. */
  updating?: boolean;
  /** Absent on the built-in slot: deleting it would leave a session on that
   *  driver with nothing to route to, so there is no affordance rather than a
   *  disabled one. */
  onRemove?: () => void;
  error?: string | null;
}) {
  const [tab, setTab] = useState<ProviderTab>("configuration");
  const title = displayNameOf(instance);
  const status = probe?.status ?? (instance.enabled ? "warning" : "disabled");
  const summary = providerSummary(probe);
  const version = versionLabel(probe?.version);
  const isDefault = isDefaultInstance(instance);
  const needsSignIn = probe?.signIn === "signed-out" || probe?.signIn === "missing-config-dir";
  // Named for the PROVIDER rather than this login, because that is what the
  // sentence is about — "Claude Code 2.1.232 is out", not "Day job 2.1.232".
  const advisory = updateAdvisory(probe, DRIVER_LABEL[instance.driver]);

  return (
    <div className={cn("rounded-xl transition-colors hover:bg-muted/20", !instance.enabled && "opacity-60")}>
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* The provider's REAL MARK, not its first letter — `claude` and
                  `codex` both start with "c", so a letter chip could not say
                  the one thing it existed to say. */}
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
              {/* The routing key, shown when the label is not already it. Every
                  session stores this string; it never changes. */}
              {title !== instance.id && (
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[0.625rem] text-muted-foreground">{instance.id}</code>
              )}
              {version && <code className="text-xs text-muted-foreground">{version}</code>}
              {/* THE MARKER IS A WAY IN, not a decoration: it sits beside the
                  version it is about, and pressing it opens the body where the
                  sentence and the command actually are. Collapsed rows are how
                  this pane is normally read, so an advisory with no affordance
                  on the collapsed row is one nobody finds. */}
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
                <Badge variant="outline" className="text-[0.625rem]" title="The provider's base login, detected rather than added">
                  built-in
                </Badge>
              )}
              {/* STATUS IS A BADGE, NOT A SENTENCE (#357), AND ONLY WHEN THERE
                  IS SOMETHING TO SAY. Every row used to carry a line of prose
                  about its own state — "Installed — Tested against 2.1.257; you
                  have 2.1.267", "Base login — sign-in state cannot be verified
                  from disk", "Off — Switched off — not offered to new sessions"
                  — on a card whose dot, version chip and switch had already
                  said it. A healthy login now reads name · version · switch and
                  nothing else; the states a reader has to ACT on keep a word,
                  and the detail behind it lives in the expanded body where the
                  sign-in command and the advisory already are. */}
              {summary && (
                <Badge variant={status === "error" ? "destructive" : "outline"} className="text-[0.625rem]">
                  {summary}
                </Badge>
              )}
            </div>
          </div>
          {/* THE ACTION CLUSTER IS FIXED and the title row is not: everything
              left of here wraps, so a long name and a long id cannot push the
              switch onto a line of its own where it looks like it belongs to
              nothing. */}
          <div className="flex w-full shrink-0 items-center gap-1 sm:w-auto sm:justify-end">
            {onRemove && (
              // The confirm dialog already says what survives; this says it
              // BEFORE the press, where the hand is, so the reader is not
              // finding out from the dialog whether it is safe to open the
              // dialog. Same sentence, same two facts.
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
            {/* CONFIGURATION AND MODELS, the two things there are to say about a
                login. They are tabs rather than two stacked sections because the
                model list is long and is read for its own sake — scrolling past
                a binary path to reach it every time is the tax that made t3
                split them too. */}
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
                  {/* Offered only when the engine sent a command. A `pinned`
                      advisory has none, and this is where that shows up: the
                      sentence explains itself and there is nothing to press. */}
                  {advisory.command && onUpdateCli && (
                    <Button size="sm" className="h-7 px-2 text-xs" disabled={updating} onClick={onUpdateCli}>
                      {updating ? <Spinner /> : <DownloadIcon className="size-3.5" />}
                      {updating ? "Updating" : "Update now"}
                    </Button>
                  )}
                </div>
                <p className="text-[0.6875rem] leading-snug text-muted-foreground">{advisory.detail}</p>
                {advisory.command && (
                  <>
                    <CopyCommand command={advisory.command} />
                    <p className="text-[0.6875rem] leading-snug text-muted-foreground/70">
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
                <p className="text-[0.6875rem] text-muted-foreground/70">
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
              <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
                Shown in the pickers. The routing key ({instance.id}) never changes.
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-foreground">Accent colour</span>
              <div className="mt-1.5">
                <AccentPicker {...(instance.accentColor ? { value: instance.accentColor } : {})} onChange={(accentColor) => onPatch({ accentColor })} />
              </div>
              <span className="mt-1 block text-[0.6875rem] text-muted-foreground">Tells this login apart from another on the same provider.</span>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-foreground">
                {instance.driver === "opencode" ? "OpenCode config folder (shared CLI login)" : instance.driver === "codex" ? "CODEX_HOME folder" : "CLAUDE_CONFIG_DIR folder"}
              </span>
              {isDefault ? (
                /* Stated rather than offered as a field. Pointing
                   CLAUDE_CONFIG_DIR at ~/.claude reaches a DIFFERENT, empty
                   Keychain entry and 401s — only an unset variable uses the base
                   login, which is why this slot has to leave it unset. */
                <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
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
                  <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
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
              {/* THE TWO SHAPES ARE THE POINT, and worth spelling out: a bare
                  name means "whatever my shell finds", which travels between
                  machines, and a full path means one exact build. Offering only
                  the second would make every export of these settings machine-
                  specific for no reason. */}
              <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
                Empty uses <code className="font-mono">{instance.driver}</code> as your shell would resolve it. A bare name looks that
                name up on PATH; a full path runs exactly that file. Beats{" "}
                <code className="font-mono">{instance.driver === "opencode" ? "OPENCODE_BIN" : instance.driver === "codex" ? "CODEX_BIN" : "CLAUDE_CODE_EXECUTABLE"}</code> when both are
                set.
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-foreground">Environment variables</span>
              <div className="mt-1.5">
                  {/*
                  RE-KEYED ON `updatedAt`, NOT ON THE ENV ITSELF.
                  A saved edit has to reseed this draft from what the engine
                  actually kept — a secret comes back as `{ value: "",
                  valueRedacted: true }` — and keying on the env's own shape
                  looked equivalent and was not: REPLACING a stored secret
                  produces a byte-identical record, so nothing changed, nothing
                  remounted, and the field went on showing the token that had
                  just been filed away. Found by typing one and looking.
                  `updatedAt` moves on every accepted write, which is exactly
                  the event that should reset the draft.
                */}
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
