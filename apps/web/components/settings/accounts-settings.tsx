"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  BellIcon,
  GaugeIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  StarIcon,
  StethoscopeIcon,
} from "lucide-react";
import type { ProviderStatus } from "@telar/core";
import type { PlanSnapshot, PlanWindow } from "@/lib/store";
import { formatResetIn, usedWindows } from "@/lib/plan-window";
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
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/common/empty-state";
import {
  SettingsShell,
  SettingsGroup,
  type SettingsSection,
} from "@/components/settings/settings-shell";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { AgentDefaultsSettings } from "@/components/settings/agent-defaults-settings";
import { NotificationsSettings } from "@/components/settings/notifications-settings";
import { DoctorSettings } from "@/components/settings/doctor-settings";
import {
  ProviderInstanceRow,
  type AccountWire,
} from "@/components/settings/provider-instances";
import { ProxyCard, type ProxyStatusWire } from "@/components/settings/proxy-card";

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

// The attribute value in these variants is QUOTED deliberately. Left bare, the
// generated attribute selector makes the CSS optimizer emit "Unexpected token
// Delim" while escaping the class name, which fails the build. Quoting produces
// the same selector and parses cleanly.
//
// AND THE BARE FORM MUST NOT APPEAR ANYWHERE IN THIS FILE — not even in a
// comment. Tailwind scans sources as PLAIN TEXT rather than parsing them, so a
// class-shaped string inside a comment is still extracted as a candidate and
// regenerates the broken rule. That is exactly how this comment reintroduced
// the bug it was written to explain.
const meterBar = (pct: number) =>
  pct >= 90
    ? "[&>[data-slot='progress-indicator']]:bg-destructive"
    : pct >= 70
      ? "[&>[data-slot='progress-indicator']]:bg-amber-500"
      : "";

function LimitMeter({ label, w }: { label: string; w?: PlanWindow | null }) {
  if (!w || w.utilization == null) return null;
  const pct = w.utilization;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">
          {pct}%
          {w.resets_at && (
            <span className="text-muted-foreground/60"> · resets in {formatResetIn(w.resets_at)}</span>
          )}
        </span>
      </div>
      <Progress value={Math.min(100, pct)} className={`h-1.5 ${meterBar(pct)}`} />
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
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Provider" },
  { id: "usage", label: "Usage", icon: GaugeIcon, group: "Provider" },
  { id: "doctor", label: "Doctor", icon: StethoscopeIcon, group: "Machine" },
];

// Legacy deep-links (/settings#accounts) still land somewhere sensible.
const SECTION_ALIASES: Record<string, string> = { accounts: "providers" };

export function GeneralSettings() {
  const [active, setActive] = useState("appearance");
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
    if (window.location.hash.slice(1) !== id) window.history.pushState(null, "", `#${id}`);
  }, []);

  // Read the URL on mount AND whenever the history entry changes, so the
  // browser's own back/forward buttons move between sections instead of
  // leaving a stale pane on screen. Done in an effect (not the initializer) so
  // SSR and the first client render agree — no hydration mismatch.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1);
      const target = SECTION_ALIASES[h] ?? h;
      if (SECTIONS.some((s) => s.id === target)) setActive(target);
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const [accounts, setAccounts] = useState<AccountWire[]>([]);
  const [defaultAccount, setDefaultAccount] = useState("personal");
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [proxy, setProxy] = useState<ProxyStatusWire | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Why an account has no usage figure, keyed by account name — returned by the
  // refresh so the Usage tab can say "no source" instead of showing a blank.
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});
  const [detecting, setDetecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    const [a, u, p, x] = await Promise.all([
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/usage").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/providers").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/proxy").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (a) {
      setAccounts(a.accounts ?? []);
      setDefaultAccount(a.default ?? "personal");
    }
    if (u) setPlan(u.plan ?? {});
    if (p) setProviders(p.providers ?? []);
    if (x) setProxy(x.proxy ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshUsage = async () => {
    setRefreshing(true);
    const r = await fetch("/api/usage/refresh", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    setUnavailable(r?.unavailable ?? {});
    await load();
    setRefreshing(false);
    window.dispatchEvent(new Event("telar:refresh"));
  };

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
      await load();
      return;
    }
    await load();
  };

  const makeDefault = async (name: string) => {
    await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ makeDefault: true }),
    }).catch(() => {});
    await load();
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
    await load();
  };

  const providerOf = (a: AccountWire) =>
    providers.find((p) => p.provider === (a.provider ?? "claude"));

  // Order is a VIEW, driven by the two controls above the list — see
  // lib/provider-order.ts for the comparator and the reason disabled-last
  // outranks whichever mode is selected.
  const ordered = orderAccounts(accounts, prefs.providerSort, prefs.providerDisabledLast);
  const disabledAt = disabledBoundary(ordered, prefs.providerDisabledLast);

  const lastChecked = providers.reduce<string | null>(
    (latest, p) => (!latest || p.checkedAt > latest ? p.checkedAt : latest),
    null,
  );
  // NOT A PROVIDER FORK — a count over provider-tagged rows, feeding a rule
  // this file does not own. packages/core/src/accounts.ts:186 is the authority
  // ("Codex supports one account for now"), and it throws whether or not this
  // Select ever disables the option; the disable is only so the form says no
  // before the server does. Left as a duplicate ON PURPOSE rather than pushed
  // into a descriptor field: publishing "maxAccounts: 1" would read as a
  // permanent property of the provider, and core's own comment says the limit
  // is an open investigation about CODEX_HOME swapping a config tree — a
  // temporary constraint dressed as a capability is the harder thing to delete
  // once it stops being true.
  const hasCodex = accounts.some((a) => (a.provider ?? "claude") === "codex");
  // EVERY ENABLED ACCOUNT gets a row, whether or not it has usage.
  //
  // Two bugs lived in the old `accounts.filter(has-windows)`: it listed
  // accounts the user had switched OFF (the sidebar hid them, this did not —
  // so the two surfaces disagreed about how many accounts you have), and it
  // silently omitted any account without a figure, which is indistinguishable
  // from that account not existing. A missing number is now a stated reason.
  const metered = accounts.filter((a) => a.enabled !== false);
  const notInstalled = providers.filter((p) => !p.installed);

  const sections = SECTIONS.map((s) =>
    s.id === "providers" ? { ...s, count: accounts.length || undefined } : s,
  );

  return (
    <SettingsShell
      title="Settings"
      subtitle="Appearance, agent defaults, notifications & provider accounts"
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
          {active === "usage" && (
            <Button variant="outline" size="sm" onClick={refreshUsage} disabled={refreshing}>
              <RotateCwIcon className={refreshing ? "animate-spin" : ""} /> Refresh usage
            </Button>
          )}
        </>
      }
    >
      {active === "appearance" && <AppearanceSettings />}
      {active === "agent" && <AgentDefaultsSettings />}
      {active === "notifications" && <NotificationsSettings />}
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
            {ordered.map((a, i) => (
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
                  proxyAvailable={Boolean(proxy?.enabled)}
                />
              </Fragment>
            ))}
          </div>

          {adding && (
            <AddInstance
              hasCodex={hasCodex}
              onAdded={() => {
                setAdding(false);
                void load();
              }}
              onCancel={() => setAdding(false)}
            />
          )}

          {proxy && (
            <ProxyCard
              proxy={proxy}
              onSaved={setProxy}
              adoptedPrefixes={accounts.flatMap((a) => (a.proxy?.prefix ? [a.proxy.prefix] : []))}
              onAdopted={load}
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

      {active === "usage" && (
        <SettingsGroup
          title="Plan limits"
          description="Live utilization per account. Refresh to fetch the latest windows."
        >
          {metered.length === 0 ? (
            <EmptyState
              className="border-none py-10"
              icon={GaugeIcon}
              title="No enabled accounts"
              description="Switch an account on in Providers to see its plan limits here."
            />
          ) : (
            metered.map((a) => {
              const snap = plan[a.name];
              return (
                <div key={a.name} className="space-y-2 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono">{a.displayName?.trim() || a.name}</span>
                    {a.displayTier && (
                      <Badge variant="outline" className="text-[10px]">{a.displayTier}</Badge>
                    )}
                    {snap?.subscriptionType && (
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {snap.subscriptionType}
                      </Badge>
                    )}
                    {a.name === defaultAccount && (
                      <Badge className="gap-1 text-[10px]">
                        <StarIcon className="size-3" /> default
                      </Badge>
                    )}
                  </div>
                  {/* One meter per window the provider actually reports, named
                      by its real duration. A Codex account today shows a single
                      weekly bar; if the 5-hour window returns, its bar returns
                      with it and nothing here changes. */}
                  {usedWindows(snap).map((row) => (
                    <LimitMeter key={row.key} label={row.label} w={row.window} />
                  ))}
                  {/* No windows is a FACT with a reason, not an empty space. */}
                  {usedWindows(snap).length === 0 && (
                    <p className="text-[11px] text-muted-foreground/70">
                      {unavailable[a.name] ??
                        "No usage captured yet — refresh to fetch it."}
                    </p>
                  )}
                  {snap?.credits?.hasCredits && (
                    <p className="text-[11px] text-muted-foreground/70">
                      credits:{" "}
                      {snap.credits.unlimited ? "unlimited" : (snap.credits.balance ?? "—")}
                    </p>
                  )}
                  {snap?.modelScoped?.map((w) => (
                    <LimitMeter key={w.display_name} label={`Weekly · ${w.display_name}`} w={w} />
                  ))}
                </div>
              );
            })
          )}
        </SettingsGroup>
      )}
    </SettingsShell>
  );
}

// Back-compat alias — the settings page renders the full sectioned surface.
export const AccountsSettings = GeneralSettings;
