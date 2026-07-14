"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BellIcon,
  GaugeIcon,
  KeyRoundIcon,
  LogInIcon,
  PaletteIcon,
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import type { AccountProfile } from "@telar/core";
import type { PlanSnapshot, PlanWindow } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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

type Provider = "claude" | "codex";
type AuthMode = "subscription" | "oauth-token" | "api-key";

// resets_at is a future ISO instant — show the countdown, not the wall clock.
const fmtReset = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const meterBar = (pct: number) =>
  pct >= 90
    ? "[&>[data-slot=progress-indicator]]:bg-destructive"
    : pct >= 70
      ? "[&>[data-slot=progress-indicator]]:bg-amber-500"
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
            <span className="text-muted-foreground/60"> · resets in {fmtReset(w.resets_at)}</span>
          )}
        </span>
      </div>
      <Progress value={Math.min(100, pct)} className={`h-1.5 ${meterBar(pct)}`} />
    </div>
  );
}

// One-line utilization hint for the Accounts tab (bars live on the Usage tab).
function usageHint(snap?: PlanSnapshot): string | null {
  const five = snap?.fiveHour?.utilization;
  const week = snap?.sevenDay?.utilization;
  if (five == null && week == null) return null;
  const parts: string[] = [];
  if (five != null) parts.push(`5-hour ${five}%`);
  if (week != null) parts.push(`weekly ${week}%`);
  return parts.join(" · ");
}

// The exact terminal command to log this account in. Interactive OAuth needs a
// browser, so we hand the user the command rather than driving it (for now).
function loginCommand(a: AccountProfile): string {
  if ((a.provider ?? "claude") === "codex") {
    return `CODEX_HOME="${a.configDir ?? "~/.codex"}" codex login`;
  }
  return a.configDir
    ? `CLAUDE_CONFIG_DIR="${a.configDir}" claude auth login`
    : "claude auth login";
}

function AccountCard({
  account,
  snap,
  isDefault,
  onChanged,
}: {
  account: AccountProfile;
  snap?: PlanSnapshot;
  isDefault: boolean;
  onChanged: () => void;
}) {
  const [tier, setTier] = useState(account.displayTier ?? "");
  const [showLogin, setShowLogin] = useState(false);
  const provider = account.provider ?? "claude";
  const hint = usageHint(snap);

  const save = async (patch: Partial<AccountProfile>) => {
    await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...account, ...patch }),
    });
    onChanged();
  };
  const makeDefault = async () => {
    await fetch(`/api/accounts/${encodeURIComponent(account.name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ makeDefault: true }),
    });
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Remove "${account.name}"? Its login on disk is left untouched.`)) return;
    await fetch(`/api/accounts/${encodeURIComponent(account.name)}`, { method: "DELETE" });
    onChanged();
  };

  return (
    <Card size="sm">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{account.name}</span>
          <Badge variant="secondary" className="text-[10px] uppercase">{provider}</Badge>
          {account.displayTier && (
            <Badge variant="outline" className="text-[10px]">{account.displayTier}</Badge>
          )}
          <Badge variant="outline" className="text-[10px]">{account.authMode ?? "subscription"}</Badge>
          {snap?.subscriptionType && (
            <Badge variant="outline" className="text-[10px] uppercase">{snap.subscriptionType}</Badge>
          )}
          {isDefault ? (
            <Badge className="gap-1 text-[10px]">
              <StarIcon className="size-3" /> default
            </Badge>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={makeDefault}>
              Make default
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 text-xs"
              onClick={() => setShowLogin((s) => !s)}
            >
              <LogInIcon className="size-3" /> Log in
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={remove} aria-label="Remove account">
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {hint ? (
            <span className="font-mono text-muted-foreground">{hint}</span>
          ) : (
            <span className="text-muted-foreground">No usage captured yet — refresh to fetch it.</span>
          )}
          {account.configDir && (
            <span
              className="ml-auto truncate font-mono text-[10px] text-muted-foreground/70"
              title={account.configDir}
            >
              {account.configDir}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Plan label</label>
          <Input
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            onBlur={() =>
              tier !== (account.displayTier ?? "") && save({ displayTier: tier || undefined })
            }
            placeholder="e.g. 20x"
            className="h-7 w-24 text-xs"
          />
        </div>

        {showLogin && (
          <div className="rounded-md border bg-muted/40 p-2">
            <p className="mb-1 text-xs text-muted-foreground">
              Run this in your terminal, then finish the login in your browser:
            </p>
            <code className="block overflow-x-auto whitespace-pre font-mono text-xs">
              {loginCommand(account)}
            </code>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddAccount({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [configDir, setConfigDir] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider, authMode, configDir: configDir || undefined }),
    });
    setBusy(false);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error ?? "Failed to add account.");
      return;
    }
    setName("");
    setConfigDir("");
    onAdded();
  };

  return (
    <Card size="sm">
      <CardContent className="space-y-3 p-4">
        <div className="text-sm font-medium">Add account</div>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-xs"
          />
          <Select value={provider} onValueChange={(v) => v && setProvider(String(v) as Provider)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">claude</SelectItem>
              <SelectItem value="codex">codex</SelectItem>
            </SelectContent>
          </Select>
          <Select value={authMode} onValueChange={(v) => v && setAuthMode(String(v) as AuthMode)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="subscription">subscription</SelectItem>
              <SelectItem value="oauth-token">oauth-token</SelectItem>
              <SelectItem value="api-key">api-key</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="config dir (optional)"
            value={configDir}
            onChange={(e) => setConfigDir(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}
        <Button size="sm" onClick={submit} disabled={!name.trim() || busy}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </CardContent>
    </Card>
  );
}

const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Preferences" },
  { id: "agent", label: "Agent defaults", icon: SparklesIcon, group: "Preferences" },
  { id: "notifications", label: "Notifications", icon: BellIcon, group: "Preferences" },
  { id: "accounts", label: "Accounts", icon: KeyRoundIcon, group: "Provider" },
  { id: "usage", label: "Usage", icon: GaugeIcon, group: "Provider" },
];

// The top-level Settings surface. Two families of section: device-local UI
// PREFERENCES (appearance, new-session agent defaults, notifications) backed by
// the ui-prefs store, and PROVIDER config (accounts + plan usage) backed by the
// account registry. Every control takes real effect — the Loom Doctrine forbids
// placebo switches, and forbids any of these UI prefs from becoming engine
// behavior (nothing here writes telar.yaml / .telar or an engine env).
export function GeneralSettings() {
  const [active, setActive] = useState("appearance");
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [defaultAccount, setDefaultAccount] = useState("personal");
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [a, u] = await Promise.all([
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/usage").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (a) {
      setAccounts(a.accounts ?? []);
      setDefaultAccount(a.default ?? "personal");
    }
    if (u) setPlan(u.plan ?? {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await fetch("/api/usage/refresh", { method: "POST" }).catch(() => {});
    await load();
    setRefreshing(false);
    window.dispatchEvent(new Event("telar:refresh"));
  };

  const sections = SECTIONS.map((s) =>
    s.id === "accounts" ? { ...s, count: accounts.length || undefined } : s,
  );

  const metered = accounts.filter(
    (a) => plan[a.name]?.fiveHour?.utilization != null || plan[a.name]?.sevenDay?.utilization != null,
  );

  return (
    <SettingsShell
      title="Settings"
      subtitle="Appearance, agent defaults, notifications & accounts"
      sections={sections}
      active={active}
      onSelect={setActive}
      headerActions={
        (active === "accounts" || active === "usage") && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RotateCwIcon className={refreshing ? "animate-spin" : ""} /> Refresh usage
          </Button>
        )
      }
    >
      {active === "appearance" && <AppearanceSettings />}

      {active === "agent" && <AgentDefaultsSettings />}

      {active === "notifications" && <NotificationsSettings />}

      {active === "accounts" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Provider logins and the default account. Tokens stay on disk — never in the registry.
          </p>
          {accounts.map((a) => (
            <AccountCard
              key={a.name}
              account={a}
              snap={plan[a.name]}
              isDefault={a.name === defaultAccount}
              onChanged={load}
            />
          ))}
          <AddAccount onAdded={load} />
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
              title="No usage captured yet"
              description="Refresh usage to fetch the 5-hour and weekly windows for each account."
            />
          ) : (
            metered.map((a) => {
              const snap = plan[a.name];
              return (
                <div key={a.name} className="space-y-2 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono">{a.name}</span>
                    {a.displayTier && (
                      <Badge variant="outline" className="text-[10px]">{a.displayTier}</Badge>
                    )}
                    {a.name === defaultAccount && (
                      <Badge className="gap-1 text-[10px]">
                        <StarIcon className="size-3" /> default
                      </Badge>
                    )}
                  </div>
                  <LimitMeter label="5-hour" w={snap?.fiveHour} />
                  <LimitMeter label="Weekly" w={snap?.sevenDay} />
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
