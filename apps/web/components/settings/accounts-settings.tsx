"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BellIcon,
  BotIcon,
  DownloadIcon,
  GaugeIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  StethoscopeIcon,
} from "lucide-react";
import type { ProviderStatus } from "@telar/core/detect";
import {
  disabledBoundary,
  orderAccounts,
  PROVIDER_SORTS,
  PROVIDER_SORT_LABELS,
  type ProviderSort,
} from "@/lib/provider-order";
import { getUiPrefs, setUiPrefs, useUiPrefs } from "@/lib/ui-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsShell,
  SettingsGroup,
  type SettingsSection,
} from "@/components/settings/settings-shell";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { AgentDefaultsSettings } from "@/components/settings/agent-defaults-settings";
import { NotificationsSettings } from "@/components/settings/notifications-settings";
import { UpdatesSettings } from "@/components/settings/updates-settings";
import { DoctorSettings } from "@/components/settings/doctor-settings";
import {
  ProviderInstanceRow,
  type AccountWire,
} from "@/components/settings/provider-instances";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
import { INTEGRATION_REGISTRY } from "@/lib/integrations/registry";

type UsageTotals = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

type UsageSummary = {
  session: UsageTotals;
  weekly: UsageTotals;
  byAccount: Record<string, { session: UsageTotals; weekly: UsageTotals }>;
};

export type SettingsInitialData = {
  accounts: AccountWire[];
  defaultAccount: string;
  usage: UsageSummary;
  providers: ProviderStatus[];
};

// TELAR ADOPTS LOGINS, IT DOES NOT CREATE THEM. There is no login panel here and
// no login route behind it: signing in happens in the user's own terminal, with
// their own CLI, and Telar's job is to notice the result.
//
// ONE LIST, NOT TWO. A provider and an account are not separate things to
// configure — an account IS a configured instance of a provider. The first row
// for each provider is the auto-detected default instance; extra rows are extra
// logins of the same provider. See provider-instances.tsx for the row anatomy.
//
// Multi-account is CLAUDE-ONLY today. Codex swaps its whole config tree via
// CODEX_HOME — sessions and history along with auth — so a second Codex account
// needs a shared-home/shadow-home arrangement Telar has not built. The server
// enforces the limit; this surface states it.

const fmtChecked = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const formatCount = (value: number) => new Intl.NumberFormat().format(value);
const formatCompactCount = (value: number) => new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
}).format(value);

function UsageWindow({ label, totals }: { label: string; totals: UsageTotals }) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(8rem,1fr)_repeat(3,minmax(6rem,auto))] sm:items-center">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">Recorded by Telar</div>
      </div>
      <div>
        <div className="font-mono text-sm">{formatCount(totals.requests)}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">requests</div>
      </div>
      <div>
        <div className="font-mono text-sm" title={`${formatCount(tokens)} total tokens`}>
          {formatCompactCount(tokens)}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {formatCompactCount(totals.inputTokens)} in · {formatCompactCount(totals.outputTokens)} out
        </div>
      </div>
      <div>
        <div className="font-mono text-sm">${totals.costUsd.toFixed(4)}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">recorded cost</div>
      </div>
    </div>
  );
}

// ── add an instance ────────────────────────────────────────────────────────
// Adding is ADOPTING: the folder must already exist and already hold a login.
// The server enforces both, plus the reserved-~/.claude rule and the Codex
// single-account limit, and its refusals are written for the user.
function AddInstance({
  hasCodex,
  onAdded,
  onCancel,
}: {
  hasCodex: boolean;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [configDir, setConfigDir] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        provider,
        authMode: "subscription",
        configDir: configDir.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error ?? "Failed to add the instance.");
      return;
    }
    setName("");
    setConfigDir("");
    onAdded();
  };

  return (
    <Card size="sm">
      <CardContent className="space-y-3 p-4">
        <div className="text-sm font-medium">Add an existing login</div>
        <p className="text-xs text-muted-foreground">
          Point Telar at a config folder you have already signed in with:
          <code className="mx-1 font-mono text-[11px]">
            CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
          </code>
          first, then add it here.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            placeholder="key, e.g. work"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-xs"
          />
          <Select
            value={provider}
            onValueChange={(v) => v && setProvider(String(v) as "claude" | "codex")}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">claude</SelectItem>
              <SelectItem value="codex" disabled={hasCodex}>
                codex{hasCodex ? " (one account only)" : ""}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="~/.claude-work"
            value={configDir}
            onChange={(e) => setConfigDir(e.target.value)}
            className="h-8 font-mono text-xs"
          />
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={!name.trim() || busy}>
            <PlusIcon className="size-3.5" /> Add
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Preferences" },
  { id: "agent", label: "Agent defaults", icon: SparklesIcon, group: "Preferences" },
  { id: "notifications", label: "Notifications", icon: BellIcon, group: "Preferences" },
  { id: "updates", label: "Updates", icon: DownloadIcon, group: "Preferences" },
  { id: "providers", label: "Providers", icon: BotIcon, group: "Provider" },
  { id: "integrations", label: "Integrations", icon: PlugIcon, group: "Provider" },
  { id: "usage", label: "Usage", icon: GaugeIcon, group: "Provider" },
  { id: "doctor", label: "Doctor", icon: StethoscopeIcon, group: "Machine" },
];

// Legacy deep-links (/settings#accounts) still land somewhere sensible.
const SECTION_ALIASES: Record<string, string> = { accounts: "providers" };

const validSection = (requested: string | null | undefined): string => {
  const normalized = SECTION_ALIASES[requested ?? ""] ?? requested;
  return SECTIONS.some((section) => section.id === normalized) ? normalized! : "appearance";
};

export function GeneralSettings({ initialData }: { initialData?: SettingsInitialData }) {
  const sectionParam = useSearchParams().get("section");
  // Resolve query deep-links during the initial render. An effect-only
  // initializer leaves /settings?section=providers visibly on Appearance until
  // hydration timers run (and background tabs may throttle those timers).
  const [active, setActive] = useState(() => validSection(sectionParam));
  const prefs = useUiPrefs();

  // THE SECTION LIVES IN THE URL. It used to be read from the hash on mount and
  // never written back, so /settings#doctor opened Doctor but clicking to
  // Providers left the address bar saying #doctor — and a refresh (or a
  // bookmark, or a link pasted to someone else) threw the section away and
  // landed on Appearance. Selecting a section now pushes it, which makes
  // reload, back/forward and copy-paste all agree with what is on screen.
  //
  // Hash rather than a route segment or a query param: these are panes of one
  // page, the deep links that already exist (/settings#doctor from the
  // dashboard first-run card) keep working unchanged, and no navigation or
  // re-render of the shell is involved in switching pane.
  const selectSection = useCallback((id: string) => {
    setActive(id);
    const url = new URL(window.location.href);
    if (url.searchParams.get("section") === id && !url.hash) return;
    url.searchParams.set("section", id);
    url.hash = "";
    window.history.pushState(null, "", url);
  }, []);

  // Read the URL on mount AND whenever the history entry changes, so the
  // browser's own back/forward buttons move between sections instead of
  // leaving a stale pane on screen. Done in an effect (not the initializer) so
  // SSR and the first client render agree — no hydration mismatch.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1);
      const requested = sectionParam || h || "appearance";
      setActive(validSection(requested));
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [sectionParam]);

  const [accounts, setAccounts] = useState<AccountWire[]>(initialData?.accounts ?? []);
  const [accountsLoaded, setAccountsLoaded] = useState(Boolean(initialData));
  const [defaultAccount, setDefaultAccount] = useState(initialData?.defaultAccount ?? "personal");
  const [usage, setUsage] = useState<UsageSummary | null>(initialData?.usage ?? null);
  const [usageLoaded, setUsageLoaded] = useState(Boolean(initialData));
  const [providers, setProviders] = useState<ProviderStatus[]>(initialData?.providers ?? []);
  const [detecting, setDetecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  const loadAccounts = useCallback(async () => {
    const data = await cachedJson<{ accounts?: AccountWire[]; default?: string }>(
      "/api/accounts",
      { force: true },
    )
      .catch(() => null);
    if (data) {
      setAccounts(data.accounts ?? []);
      setDefaultAccount(data.default ?? "personal");
    }
    setAccountsLoaded(true);
  }, []);

  const loadUsage = useCallback(async () => {
    const data = await cachedJson<{ ledger?: UsageSummary }>("/api/usage", { force: true })
      .catch(() => null);
    if (data?.ledger) setUsage(data.ledger);
    setUsageLoaded(true);
  }, []);

  const loadProviderStatus = useCallback(async () => {
    const data = await cachedJson<{ providers?: ProviderStatus[] }>("/api/providers")
      .catch(() => null);
    if (data) setProviders(data.providers ?? []);
  }, []);

  useEffect(() => {
    if (active !== "providers" && active !== "usage") return;
    if (initialData) return;
    queueMicrotask(() => {
      void loadAccounts();
    });
  }, [active, initialData, loadAccounts]);

  useEffect(() => {
    if (active !== "usage") return;
    if (initialData) return;
    queueMicrotask(() => {
      void loadUsage();
    });
  }, [active, initialData, loadUsage]);

  // Provider detection is scoped to the provider pane. It never probes an
  // optional integration.
  useEffect(() => {
    if (active !== "providers") return;
    if (initialData) return;
    queueMicrotask(() => {
      void loadProviderStatus();
    });
  }, [active, initialData, loadProviderStatus]);

  // Re-detect: one `--version` per provider, plus whatever plan the latest
  // usage snapshot knows. Cheap enough to be a button, too costly to be a poll
  // the user didn't ask for — hence the interval control below, default 5m.
  const redetect = useCallback(async () => {
    setDetecting(true);
    const r = await fetch("/api/providers", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    if (r) setProviders(r.providers ?? []);
    setDetecting(false);
  }, []);

  // The interval takes effect exactly where the label says: while this page is
  // open, on the Providers section. Zero disables it. No hidden background poll.
  // `redetect` is a useCallback with no deps, so it is stable and can be a real
  // dependency here — no ref needed to dodge the re-subscribe.
  useEffect(() => {
    const secs = prefs.providerCheckIntervalSec;
    if (active !== "providers" || secs <= 0) return;
    const id = setInterval(() => void redetect(), secs * 1000);
    return () => clearInterval(id);
  }, [active, prefs.providerCheckIntervalSec, redetect]);

  const patchAccount = async (account: AccountWire, patch: Partial<AccountWire>) => {
    setRowError((e) => ({ ...e, [account.name]: null }));
    // The whole profile round-trips: the wire shape IS the profile plus
    // server-computed extras, and the server ignores what it did not define.
    const r = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...account, ...patch }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setRowError((e) => ({ ...e, [account.name]: d.error ?? "That didn't work." }));
      // Re-read so the UI shows what the server actually kept, not the rejected
      // edit — otherwise a refused config dir lingers in the field as if saved.
      await loadAccounts();
      return;
    }
    await loadAccounts();
    dispatchTelarRefresh({ domains: ["accounts"] });
  };

  const makeDefault = async (name: string) => {
    await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ makeDefault: true }),
    }).catch(() => {});
    await loadAccounts();
    dispatchTelarRefresh({ domains: ["accounts"] });
  };

  const removeAccount = async (account: AccountWire) => {
    if (!confirm(`Remove "${account.name}"? Its login on disk is left untouched.`)) return;
    const r = await fetch(`/api/accounts/${encodeURIComponent(account.name)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setRowError((e) => ({ ...e, [account.name]: d.error ?? "Could not remove it." }));
    }
    await loadAccounts();
    dispatchTelarRefresh({ domains: ["accounts"] });
  };

  const providerOf = (a: AccountWire) =>
    providers.find((p) => p.provider === (a.provider ?? "claude"));

  // Order is a VIEW, driven by the two controls above the list — see
  // lib/provider-order.ts for the comparator and the reason disabled-last
  // outranks whichever mode is selected.
  const providerAccounts = accounts;
  const ordered = orderAccounts(providerAccounts, prefs.providerSort, prefs.providerDisabledLast);
  const disabledAt = disabledBoundary(ordered, prefs.providerDisabledLast);

  const lastChecked = providers.reduce<string | null>(
    (latest, p) => (!latest || p.checkedAt > latest ? p.checkedAt : latest),
    null,
  );
  const hasCodex = accounts.some((a) => (a.provider ?? "claude") === "codex");
  const notInstalled = providers.filter((p) => !p.installed);

  const sections = SECTIONS.map((s) =>
    s.id === "providers"
      ? { ...s, count: providerAccounts.length || undefined }
      : s.id === "integrations"
        ? { ...s, count: INTEGRATION_REGISTRY.length || undefined }
        : s,
  );
  return (
    <SettingsShell
      title="Settings"
      subtitle="Workspace preferences, local harnesses, integrations & usage"
      sections={sections}
      active={active}
      onSelect={selectSection}
      headerActions={
        <>
          {active === "providers" && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                last checked {fmtChecked(lastChecked)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAdding((v) => !v)}
                aria-label="Add provider instance"
              >
                <PlusIcon />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={redetect}
                disabled={detecting}
                aria-label="Re-check providers"
              >
                <RotateCwIcon className={detecting ? "animate-spin" : ""} />
              </Button>
            </div>
          )}
        </>
      }
    >
      {active === "appearance" && <AppearanceSettings />}
      {active === "agent" && <AgentDefaultsSettings />}
      {active === "notifications" && <NotificationsSettings />}
      {active === "updates" && <UpdatesSettings />}
      {active === "doctor" && <DoctorSettings />}

      {active === "providers" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Each row is one login. Telar runs the CLIs already on this machine and never signs you
            in — the main Claude account is detected, and additional ones are config folders you
            point it at. Tokens stay where the CLI put them.
          </p>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-medium">Re-check interval</div>
              <div className="text-[11px] text-muted-foreground">
                Automatically re-check versions and plans while this page is open. 0 = manual only.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Input
                type="number"
                min={0}
                step={30}
                value={prefs.providerCheckIntervalSec}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 0)
                    setUiPrefs({ ...getUiPrefs(), providerCheckIntervalSec: Math.floor(n) });
                }}
                className="h-8 w-24 text-xs"
              />
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          </div>

          {notInstalled.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
              {notInstalled.map((p) => p.label).join(" and ")}{" "}
              {notInstalled.length > 1 ? "are" : "is"} not on this machine&apos;s PATH. Install the
              CLI to use {notInstalled.length > 1 ? "those accounts" : "that account"}.
            </div>
          )}

          {/* Ordering controls. Deliberately ABOVE the list and always visible
              rather than tucked behind a menu: the list reorders itself the
              moment one changes, and a control whose effect you cannot see
              while you use it is a control people stop trusting. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">Sort by</span>
              <Select
                value={prefs.providerSort}
                onValueChange={(v) =>
                  v && setUiPrefs({ ...getUiPrefs(), providerSort: String(v) as ProviderSort })
                }
              >
                <SelectTrigger className="h-7 w-32 text-xs" aria-label="Sort accounts by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_SORTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {PROVIDER_SORT_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">
                {prefs.providerSort === "status"
                  ? "Accounts needing attention first."
                  : prefs.providerSort === "name"
                    ? "Alphabetical, across providers."
                    : "Grouped by provider, detected login first."}
              </span>
            </div>
            <label className="flex shrink-0 items-center gap-2">
              <Switch
                checked={prefs.providerDisabledLast}
                onCheckedChange={(c) =>
                  setUiPrefs({ ...getUiPrefs(), providerDisabledLast: Boolean(c) })
                }
                aria-label="Move disabled accounts to the bottom"
              />
              <span className="text-xs">Disabled at the bottom</span>
            </label>
          </div>

          <div className="divide-y rounded-xl border">
            {!accountsLoaded && (
              <div className="flex items-center gap-2 px-4 py-5 text-xs text-muted-foreground">
                <RotateCwIcon className="size-3.5 animate-spin" /> Loading provider accounts…
              </div>
            )}
            {accountsLoaded && ordered.map((a, i) => (
              <Fragment key={a.name}>
                {/* The boundary is LABELLED, not just implied by the dimming.
                    Rows that moved need to say why they moved — otherwise the
                    account you just switched off appears to have vanished from
                    where you left it. */}
                {i === disabledAt && (
                  <div className="flex items-center gap-2 bg-muted/20 px-3 py-1.5 sm:px-4">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Disabled
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      Switched off — not offered to sessions or counted in usage.
                    </span>
                  </div>
                )}
                <ProviderInstanceRow
                  account={a}
                  provider={providerOf(a)}
                  isDefault={a.name === defaultAccount}
                  expanded={Boolean(expanded[a.name])}
                  onToggleExpanded={(next) => setExpanded((e) => ({ ...e, [a.name]: next }))}
                  onPatch={(patch) => void patchAccount(a, patch)}
                  onMakeDefault={() => void makeDefault(a.name)}
                  onRemove={() => void removeAccount(a)}
                  error={rowError[a.name]}
                />
              </Fragment>
            ))}
          </div>

          {adding && (
            <AddInstance
              hasCodex={hasCodex}
              onAdded={() => {
                setAdding(false);
                void loadAccounts();
                dispatchTelarRefresh({ domains: ["accounts"] });
              }}
              onCancel={() => setAdding(false)}
            />
          )}

          {hasCodex && (
            <p className="text-[11px] text-muted-foreground/70">
              Codex is limited to one account for now. <code className="font-mono">CODEX_HOME</code>{" "}
              swaps its entire config tree — sessions and history along with auth — so a second
              Codex login needs work Telar hasn&apos;t done yet.
            </p>
          )}
        </div>
      )}

      {active === "integrations" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">Integration workspace</h4>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {INTEGRATION_REGISTRY.length} installed
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Pluggable adapters add optional capabilities around a harness. Each adapter owns its
              settings and data; removing one leaves providers, accounts, models, and sessions
              untouched.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px] font-normal">
                providers stay native
              </Badge>
              <Badge variant="outline" className="text-[10px] font-normal">
                harness owns models
              </Badge>
              <Badge variant="outline" className="text-[10px] font-normal">
                opt-in and removable
              </Badge>
            </div>
          </div>
          <div className="flex items-end justify-between gap-3 pt-1">
            <div>
              <h4 className="text-sm font-medium">Installed integrations</h4>
              <p className="text-xs text-muted-foreground">
                Add future adapters to the registry; each appears here as its own settings card.
              </p>
            </div>
          </div>
          {INTEGRATION_REGISTRY.map(({ definition, Settings }) => (
            <Settings
              key={definition.id}
              definition={definition}
            />
          ))}
          {INTEGRATION_REGISTRY.length === 0 && (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center">
              <PlugIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
              <h4 className="text-sm font-medium">No integrations installed</h4>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                Telar works with your local harnesses on its own. Optional adapters can add browser,
                issue tracking, notifications, and other workspace capabilities later.
              </p>
            </div>
          )}
        </div>
      )}

      {active === "usage" && (
        <SettingsGroup
          title="Recorded usage"
          description="Requests, tokens, and cost recorded by Telar while sessions run. Provider quotas and subscription limits are intentionally not inferred."
        >
          {!usageLoaded ? (
            <div className="flex items-center gap-2 px-4 py-5 text-xs text-muted-foreground">
              <RotateCwIcon className="size-3.5 animate-spin" /> Loading recorded usage…
            </div>
          ) : usage ? (
            <>
              <UsageWindow label="Last 5 hours" totals={usage.session} />
              <UsageWindow label="Last 7 days" totals={usage.weekly} />
              <div className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                Stored in Telar&apos;s local append-only ledger. This is observed session activity,
                not a provider quota or subscription balance.
              </div>
            </>
          ) : (
            <p className="px-4 py-5 text-xs text-muted-foreground">No usage has been recorded yet.</p>
          )}
        </SettingsGroup>
      )}
    </SettingsShell>
  );
}

// Back-compat alias — the settings page renders the full sectioned surface.
export const AccountsSettings = GeneralSettings;
