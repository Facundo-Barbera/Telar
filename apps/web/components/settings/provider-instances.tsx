"use client";

// THE PROVIDER SURFACE: one list, one row per account.
//
// Modeled on T3 Code's ProviderInstanceCard, which is the shape this problem
// wants — an account is not a separate concept from "a provider you configured",
// it IS a configured instance of a provider. So there is no Providers section
// listing CLIs and an Accounts section listing logins: the first row for a
// provider is the auto-detected default instance, and every extra row is
// another login of the same provider. Collapsed, a row states what it is and
// whether it works; expanded, it holds everything that makes it that account.
//
// Telar keeps one concept T3 Code has no equivalent for: the DEFAULT account,
// which ProjectManifest.account resolves to. That is the star control.
//
// Nothing here signs anyone in. A row that isn't signed in shows the command to
// run in a terminal, and that is the whole of Telar's involvement in auth.

import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { AccountHealth, AccountIdentity, ProviderStatus } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CopyCommand } from "@/components/settings/copy-command";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";

// ── wire shape ─────────────────────────────────────────────────────────────
export type AccountEnvVarWire = {
  name: string;
  value: string;
  sensitive: boolean;
  // Server-set: the value exists but was withheld. Submitting it back empty
  // means "keep the stored secret" — see accounts.ts stashSensitiveEnv.
  valueRedacted?: boolean;
};

export type AccountWire = {
  name: string;
  provider?: "claude" | "codex";
  authMode?: "subscription" | "oauth-token" | "api-key";
  configDir?: string;
  displayName?: string;
  accentColor?: string;
  enabled?: boolean;
  displayTier?: string;
  env?: AccountEnvVarWire[];
  // Presence = routed through the CLIProxyAPI gateway. `prefix` pins one
  // upstream credential; absent lets the gateway's own strategy choose.
  proxy?: { prefix?: string };
  health?: AccountHealth;
  isMain?: boolean;
  identity?: AccountIdentity | null;
  signInHint?: string;
};

// ── redaction ──────────────────────────────────────────────────────────────
// An email is not a secret, but it is personal, and a settings screen is a
// thing people screen-share. So it renders as a stable scramble that keeps the
// SHAPE (@ . - _ survive) and reveals on click. Deterministic — the same
// address always scrambles the same way, so two rows showing the same account
// still look the same without either being legible.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function scramble(value: string): string {
  let state = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < value.length; i++) {
    state ^= value.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  const next = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return ALPHABET[Math.abs(state) % ALPHABET.length] ?? "x";
  };
  return Array.from(value, (ch) => ("@.-_".includes(ch) ? ch : next())).join("");
}

function RedactedText({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setShown((s) => !s)}
      title={shown ? "Click to hide" : "Click to reveal"}
      className={cn(
        "min-w-0 cursor-pointer rounded-sm font-mono text-[11px] leading-none transition hover:text-foreground",
        shown ? "text-muted-foreground" : "select-none text-muted-foreground blur-[3px]",
      )}
    >
      {shown ? value : scramble(value)}
    </button>
  );
}

// ── accent colour ──────────────────────────────────────────────────────────
const SWATCHES = ["#2563eb", "#16a34a", "#ea580c", "#dc2626", "#7c3aed", "#0891b2"] as const;

export const isHexColor = (v: string): boolean => /^#[0-9a-fA-F]{6}$/.test(v.trim());

function AccentPicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Accent ${c}`}
          onClick={() => onChange(c)}
          style={{ backgroundColor: c }}
          className={cn(
            "size-5 rounded-full ring-offset-2 ring-offset-background transition",
            value?.toLowerCase() === c ? "ring-2 ring-ring" : "hover:scale-110",
          )}
        />
      ))}
      <button
        type="button"
        aria-label="No accent"
        onClick={() => onChange(undefined)}
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

// ── status ─────────────────────────────────────────────────────────────────
// The dot is the whole status language, same as T3 Code's. It reports the
// ACCOUNT's liveness, not the provider's: a green CLI with a signed-out config
// folder is not a working account, and the row that has to be honest is this one.
function statusDot(account: AccountWire, provider?: ProviderStatus): string {
  if (account.enabled === false) return "bg-muted-foreground/40";
  if (provider && !provider.installed) return "bg-destructive";
  switch (account.health?.status) {
    case "ok":
      return "bg-emerald-500";
    case "never-logged-in":
    case "missing-config-dir":
      return "bg-destructive";
    default:
      return "bg-amber-400"; // "unknown" — a keychain login we cannot prove
  }
}

// The line under the title. Prefers the REAL signed-in identity; falls back to
// health's own wording. Never invents an email for a provider that reports none
// (Codex keeps its identity in a credential file we refuse to read).
function authLine(account: AccountWire, provider?: ProviderStatus) {
  const identity = account.identity;
  // planLabel is the account's OWN plan ("Claude Max 20x"); the provider-level
  // label is a fallback for accounts whose profile says nothing. Never the raw
  // `tier` token, and never billingType — see account-identity.ts.
  const plan = identity?.planLabel ?? provider?.auth.label ?? provider?.auth.type ?? null;
  if (identity?.email) {
    return (
      <>
        <span>Authenticated as</span>
        <RedactedText value={identity.email} />
        {plan && <span>· {plan}</span>}
        {identity.organization && <span>· {identity.organization}</span>}
      </>
    );
  }
  if (account.health?.status === "ok") return <span>Signed in{plan ? ` · ${plan}` : ""}</span>;
  if (account.health?.status === "never-logged-in") return <span>Not signed in</span>;
  if (account.health?.status === "missing-config-dir")
    return <span>Config folder not found on this machine</span>;
  return <span>{account.health?.detail ?? "Sign-in state unverified"}</span>;
}


// ── environment variables ──────────────────────────────────────────────────
function EnvEditor({
  env,
  onChange,
}: {
  env: AccountEnvVarWire[];
  onChange: (next: AccountEnvVarWire[]) => void;
}) {
  const patch = (i: number, p: Partial<AccountEnvVarWire>) =>
    onChange(env.map((v, j) => (j === i ? { ...v, ...p } : v)));

  return (
    <div className="space-y-1.5">
      {env.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={v.name}
            onChange={(e) => patch(i, { name: e.target.value })}
            placeholder="NAME"
            className="h-7 w-40 font-mono text-xs"
          />
          <Input
            value={v.value}
            onChange={(e) => patch(i, { value: e.target.value, valueRedacted: false })}
            // A stored secret is never sent to the client, so the field shows a
            // placeholder saying so — typing replaces it, leaving it empty keeps it.
            placeholder={v.valueRedacted ? "•••••• (stored — type to replace)" : "value"}
            type={v.sensitive ? "password" : "text"}
            className="h-7 flex-1 font-mono text-xs"
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={v.sensitive}
              onChange={(e) => patch(i, { sensitive: e.target.checked })}
              className="size-3"
            />
            secret
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${v.name || "variable"}`}
            onClick={() => onChange(env.filter((_, j) => j !== i))}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground"
        onClick={() => onChange([...env, { name: "", value: "", sensitive: false }])}
      >
        <PlusIcon className="size-3" /> Add variable
      </Button>
      <p className="text-[11px] text-muted-foreground/70">
        Passed to this account&apos;s agent process, applied after the provider&apos;s own config
        dir and token. Values marked secret are stored in the credential file, never in the account
        registry, and are not sent back to this page.
      </p>
    </div>
  );
}

// ── one instance ───────────────────────────────────────────────────────────
export function ProviderInstanceRow({
  account,
  provider,
  isDefault,
  expanded,
  onToggleExpanded,
  onPatch,
  onMakeDefault,
  onRemove,
  error,
  proxyAvailable,
}: {
  account: AccountWire;
  provider?: ProviderStatus;
  isDefault: boolean;
  expanded: boolean;
  onToggleExpanded: (next: boolean) => void;
  onPatch: (patch: Partial<AccountWire>) => void;
  onMakeDefault: () => void;
  onRemove: () => void;
  error?: string | null;
  // The gateway is configured and switched on. When it isn't, the routing
  // control is hidden rather than shown-and-disabled: an account cannot be
  // routed through something that does not exist, and offering the switch would
  // imply otherwise.
  proxyAvailable?: boolean;
}) {
  const providerId = account.provider ?? "claude";
  const title = account.displayName?.trim() || account.name;
  const enabled = account.enabled !== false;
  const needsSignIn =
    account.health?.status === "never-logged-in" ||
    account.health?.status === "missing-config-dir";
  // Local drafts so typing doesn't fire a PUT per keystroke — committed on blur.
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [configDir, setConfigDir] = useState(account.configDir ?? "");
  const [tier, setTier] = useState(account.displayTier ?? "");
  const [prefix, setPrefix] = useState(account.proxy?.prefix ?? "");
  const routed = Boolean(account.proxy);

  return (
    <div className={cn("rounded-xl transition-colors hover:bg-muted/20", !enabled && "opacity-60")}>
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* The provider's REAL MARK, not its first letter. Both providers
                  used to start with the same glyph in the same grey square —
                  `claude` and `codex` both rendered "c" — so the one thing the
                  chip existed to say was the one thing it could not say. The
                  brand mark is legible at 13px and needs no legend.
                  ProviderIcon is the app's existing one (session/provider-icon).

                  The ACCENT survives as the chip's tint rather than a fill: the
                  marks carry their own colour (Claude's #d97757, Codex's
                  currentColor), and painting a user-chosen background behind
                  them turned a brand mark into a swatch. As a soft wash plus a
                  ring it still distinguishes two logins of the same provider,
                  which is the job it was doing. */}
              <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                <span
                  className="flex size-5 items-center justify-center rounded-[5px] ring-1 ring-inset ring-border/60"
                  style={
                    account.accentColor
                      ? {
                          backgroundColor: `color-mix(in srgb, ${account.accentColor} 22%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${account.accentColor} 55%, transparent)`,
                        }
                      : undefined
                  }
                  title={PROVIDER_LABEL[providerId]}
                >
                  <ProviderIcon provider={providerId} size={13} />
                </span>
                <span
                  className={cn(
                    "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
                    statusDot(account, provider),
                  )}
                  aria-hidden
                />
              </span>
              <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
              {/* the stable registry key, shown when the label differs from it */}
              {title !== account.name && (
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {account.name}
                </code>
              )}
              {provider?.version && (
                <code className="text-xs text-muted-foreground">{provider.version}</code>
              )}
              {account.isMain && (
                <Badge variant="outline" className="text-[10px]" title="Detected automatically — the provider's base login">
                  detected
                </Badge>
              )}
              {routed && (
                <Badge
                  variant="secondary"
                  className="text-[10px]"
                  title={
                    account.proxy?.prefix
                      ? `Routed through CLIProxyAPI, pinned to "${account.proxy.prefix}"`
                      : "Routed through CLIProxyAPI"
                  }
                >
                  proxied{account.proxy?.prefix ? ` · ${account.proxy.prefix}` : ""}
                </Badge>
              )}
              {isDefault ? (
                <Badge className="gap-1 text-[10px]">
                  <StarIcon className="size-3" /> default
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[11px] text-muted-foreground"
                  onClick={onMakeDefault}
                >
                  Make default
                </Button>
              )}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
              {authLine(account, provider)}
            </p>
          </div>
          {/* THE ACTION CLUSTER IS FIXED, the title row is not. Everything left
              of here wraps — the badges are as long as the account names and
              prefixes people choose, so `proxied · codex-personal` pushed the
              delete button onto a line of its own, where it hovered above the
              auth line looking like it belonged to nothing. Controls that act
              on the ROW live here instead, in the same place on every row
              whatever the badges do. */}
          <div className="flex w-full shrink-0 items-center gap-1 sm:w-auto sm:justify-end">
            {/* The main account is detected, not added, and every project
                manifest defaults to it — so there is no delete affordance. */}
            {!account.isMain && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={onRemove}
                aria-label={`Remove ${account.name}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onToggleExpanded(!expanded)}
              aria-label={`Toggle ${title} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </Button>
            <Switch
              className="ml-1"
              checked={enabled}
              onCheckedChange={(checked) => onPatch({ enabled: Boolean(checked) })}
              aria-label={`Enable ${title}`}
            />
          </div>
        </div>
      </div>

      <Collapsible open={expanded} onOpenChange={onToggleExpanded}>
        <CollapsibleContent>
          <div className="space-y-4 px-3 pb-4 pt-1 sm:px-4">
            {needsSignIn && account.signInHint && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">Sign in</span>
                <CopyCommand command={account.signInHint} />
                <p className="text-[11px] text-muted-foreground/70">
                  Run this in your terminal. Telar reads the result — it never signs in for you.
                </p>
              </div>
            )}

            <label className="block">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() =>
                  displayName !== (account.displayName ?? "") &&
                  onPatch({ displayName: displayName.trim() || undefined })
                }
                placeholder={account.name}
                className="mt-1.5 h-8 text-xs"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Shown in the pickers. The account key ({account.name}) never changes.
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-foreground">Accent color</span>
              <div className="mt-1.5">
                <AccentPicker
                  value={account.accentColor}
                  onChange={(accentColor) => onPatch({ accentColor })}
                />
              </div>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Distinguishes this account in the sidebar wheel and the pickers.
              </span>
            </div>

            {/* The main Claude login pins no config dir BY DESIGN — pointing
                CLAUDE_CONFIG_DIR at ~/.claude reaches a different, empty
                Keychain entry. So it is stated, not offered as a field. */}
            <label className="block">
              <span className="text-xs font-medium text-foreground">
                {providerId === "codex" ? "CODEX_HOME path" : "CLAUDE_CONFIG_DIR path"}
              </span>
              {account.isMain ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Empty — this is the base login. Setting the variable here would reach a different,
                  empty Keychain entry, so Telar leaves it unset.
                </p>
              ) : (
                <>
                  <Input
                    value={configDir}
                    onChange={(e) => setConfigDir(e.target.value)}
                    onBlur={() =>
                      configDir !== (account.configDir ?? "") &&
                      onPatch({ configDir: configDir.trim() || undefined })
                    }
                    placeholder="~/.claude-work"
                    className="mt-1.5 h-8 font-mono text-xs"
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    The folder this account is signed in with. It must already exist.
                  </span>
                </>
              )}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground">Plan label</span>
              <Input
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                onBlur={() =>
                  tier !== (account.displayTier ?? "") &&
                  onPatch({ displayTier: tier.trim() || undefined })
                }
                placeholder="e.g. 20x"
                className="mt-1.5 h-8 w-28 text-xs"
              />
            </label>

            {(proxyAvailable || routed) && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={routed}
                    onCheckedChange={(c) => onPatch({ proxy: c ? {} : undefined })}
                    aria-label={`Route ${title} through CLIProxyAPI`}
                  />
                  <span className="text-xs font-medium text-foreground">
                    Route through CLIProxyAPI
                  </span>
                </div>
                {routed ? (
                  <>
                    <Input
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      onBlur={() =>
                        prefix !== (account.proxy?.prefix ?? "") &&
                        onPatch({ proxy: { prefix: prefix.trim() || undefined } })
                      }
                      placeholder="upstream prefix (optional)"
                      className="h-8 font-mono text-xs"
                    />
                    <span className="block text-[11px] text-muted-foreground">
                      Empty lets the gateway pick from its pool. A prefix pins this account to one
                      upstream login — it must match that credential&apos;s{" "}
                      <code className="font-mono">prefix</code> in the proxy&apos;s own config.
                    </span>
                  </>
                ) : (
                  <span className="block text-[11px] text-muted-foreground">
                    Off: this account talks to {providerId === "codex" ? "OpenAI" : "Anthropic"}{" "}
                    directly.
                  </span>
                )}
              </div>
            )}

            <div>
              <span className="text-xs font-medium text-foreground">Environment variables</span>
              <div className="mt-1.5">
                <EnvEditor env={account.env ?? []} onChange={(env) => onPatch({ env })} />
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
