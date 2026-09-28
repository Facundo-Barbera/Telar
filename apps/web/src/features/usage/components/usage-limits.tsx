"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ProviderDriverKind, UsageLimitAccount, UsageLimitSourceSnapshot, UsageLimitWindow } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { DRIVER_LABEL } from "../model";
import { cn } from "@/ui/utils";

const api = createEngineApi();

const SEGMENT_COLOR = ["var(--chart-1)", "var(--chart-2)"] as const;

const HEADLINE_WINDOW: Record<string, string> = { claude: "five_hour", codex: "primary" };

function headlineWindow(account: UsageLimitAccount): UsageLimitWindow | undefined {
  const preferred = HEADLINE_WINDOW[account.driver];
  return account.windows.find((entry) => entry.key === preferred) ?? account.windows[0];
}

export function fmtUntil(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return "in under a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `in ${days}d ${hours % 24}h` : `in ${days}d`;
}

export function remainingPercent(window: UsageLimitWindow | undefined): number | undefined {
  return window ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : undefined;
}

/** Mean remaining across accounts that reported a headline window; failed reads are skipped. */
export function pooledRemaining(accounts: readonly UsageLimitAccount[]): number | undefined {
  const values = accounts.map((account) => remainingPercent(headlineWindow(account))).filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0) / values.length;
}

function accountLabel(account: UsageLimitAccount): string {
  return account.email ?? account.plan ?? account.id;
}

function Segment({
  account,
  color,
  selected,
  onSelect,
}: {
  account: UsageLimitAccount;
  color: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const window = headlineWindow(account);
  const remaining = remainingPercent(window);
  const label = `${accountLabel(account)} — ${remaining === undefined ? (account.error ?? "no reading") : `${Math.round(remaining)}% left`}`;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={label}
      aria-label={label}
      className={cn(
        "group relative h-7 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted transition-opacity",
        selected ? "ring-1 ring-ring" : "opacity-90 hover:opacity-100",
      )}
    >
      {remaining === undefined ? (
        <span
          className="absolute inset-0"
          style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--muted-foreground) 0 2px, transparent 2px 6px)", opacity: 0.25 }}
        />
      ) : (
        <span className="absolute inset-x-0 bottom-0 transition-[height]" style={{ height: `${remaining}%`, backgroundColor: color }} />
      )}
    </button>
  );
}

function AccountDetail({ account }: { account: UsageLimitAccount }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="truncate text-sm font-medium">{accountLabel(account)}</span>
        {account.plan && <span className="text-xs text-muted-foreground">{account.plan}</span>}
      </div>
      {account.error ? (
        <p className="mt-1.5 text-xs text-destructive">{account.error}</p>
      ) : account.windows.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">This account reported no limits.</p>
      ) : (
        <dl className="mt-2 space-y-1">
          {account.windows.map((window) => (
            <div key={window.key} className="flex items-baseline gap-2 text-xs">
              <dt className="min-w-0 flex-1 truncate text-muted-foreground">{window.label}</dt>
              <dd className="tabular-nums">{Math.round(remainingPercent(window)!)}% left</dd>
              <dd className="w-24 text-right text-muted-foreground">{window.resetsAt === undefined ? "" : `resets ${fmtUntil(window.resetsAt)}`}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ProviderCard({ driver, accounts }: { driver: ProviderDriverKind; accounts: UsageLimitAccount[] }) {
  const [selected, setSelected] = useState<string>();
  const pooled = pooledRemaining(accounts);
  const unread = accounts.filter((account) => headlineWindow(account) === undefined).length;
  const chosen = accounts.find((account) => account.id === selected);

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl p-4 ring-1 ring-foreground/10">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{DRIVER_LABEL[driver]}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
          {unread > 0 ? ` · ${unread} unread` : ""}
        </span>
        <span className="text-lg font-medium tabular-nums">{pooled === undefined ? "—" : `${Math.round(pooled)}%`}</span>
      </div>
      <div className="flex items-stretch gap-1">
        {accounts.map((account, index) => (
          <Segment
            key={account.id}
            account={account}
            color={SEGMENT_COLOR[index % SEGMENT_COLOR.length]!}
            selected={account.id === selected}
            onSelect={() => setSelected((current) => (current === account.id ? undefined : account.id))}
          />
        ))}
      </div>
      {chosen ? (
        <AccountDetail account={chosen} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {accounts.length === 1 ? "One seat" : "One segment per seat"}, filled by what is left of the{" "}
          {driver === "codex" ? "primary" : "5-hour"} window. Choose one for its plan and resets.
        </p>
      )}
    </div>
  );
}

export function UsageLimitsSection() {
  const [sources, setSources] = useState<UsageLimitSourceSnapshot[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const { limits } = await api.usageLimits(refresh ? { refresh: true } : {});
      setSources(limits.sources);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine did not answer.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const byDriver = useMemo(() => {
    const groups = new Map<ProviderDriverKind, UsageLimitAccount[]>();
    for (const source of sources ?? []) {
      for (const account of source.accounts) {
        const existing = groups.get(account.driver);
        if (existing) existing.push(account);
        else groups.set(account.driver, [account]);
      }
    }
    return [...groups.entries()];
  }, [sources]);

  // A failed first read stays silent: it can't tell "no hubs" from "couldn't ask".
  if (!sources || sources.length === 0) return null;

  const failed = sources.filter((source) => source.error);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Limits</p>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh limits" onClick={() => void load(true)} disabled={loading}>
          {loading ? <Spinner /> : <RotateCwIcon />}
        </Button>
      </div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {byDriver.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {byDriver.map(([driver, accounts]) => (
            <ProviderCard key={driver} driver={driver} accounts={accounts} />
          ))}
        </div>
      )}
      {failed.map((source) => (
        <p key={source.id} className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
          {source.label}: {source.error}
        </p>
      ))}
      {byDriver.length === 0 && failed.length === 0 && (
        <p className="text-xs text-muted-foreground">No accounts on the configured hubs.</p>
      )}
    </section>
  );
}
