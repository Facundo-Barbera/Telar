"use client";

// The CLIProxyAPI gateway card — an OPTIONAL instance Telar can route accounts
// through, rendered alongside the provider rows rather than replacing them.
//
// It states three separable facts, because they fail separately and a surface
// that collapsed them would lie about two of the three:
//   1. is a proxy listening here      (root probe, no auth)
//   2. what will it serve             (needs the API key)
//   3. which logins are behind it     (needs the management key)
// Missing key #3 is not an error; it just means the pool is unknown.
//
// NEITHER KEY IS EVER RENDERED. The server sends booleans, so a "set" field
// here has no value to leak into a screenshot or a devtools payload.

import { useState } from "react";
import { CheckIcon, PlugIcon, PlusIcon, RotateCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CopyCommand } from "@/components/settings/copy-command";

export type ProxyUpstreamWire = {
  id: string;
  name: string;
  provider: string | null;
  label: string | null;
  email: string | null;
  accountType: string | null;
  status: string | null;
  prefix: string | null;
  disabled: boolean;
  unavailable: boolean;
  success: number | null;
  failed: number | null;
};

export type ManagementBreakerWire = {
  blocked: boolean;
  reason: string | null;
  at: string | null;
  remedy: string;
};

export type ProxyStatusWire = {
  enabled: boolean;
  url: string;
  reachable: boolean;
  hasApiKey: boolean;
  hasManagementKey: boolean;
  models: string[];
  // The pool is NOT here. Reading it spends a management auth attempt against a
  // hardcoded lockout, so it is fetched only when the user clicks for it.
  management: ManagementBreakerWire;
  error: string | null;
  checkedAt: string;
};

// A gateway catalog mixes harnesses; split it so "9 Claude · 14 GPT" is visible
// at a glance, since cross-harness reach is the reason to run one at all.
function splitModels(models: string[]): { claude: string[]; other: string[] } {
  const claude: string[] = [];
  const other: string[] = [];
  for (const m of models) (m.startsWith("claude") ? claude : other).push(m);
  return { claude, other };
}

// ADOPTING an upstream turns a pooled login into a named Telar account: the
// gateway pins the credential to a `prefix`, and the account carries that prefix
// so every turn resolves to that login and no other. Without it the gateway's
// routing strategy picks — right for capacity, wrong when you mean "run this on
// work".
function UpstreamRow({
  u,
  adopted,
  onAdopt,
  busy,
}: {
  u: ProxyUpstreamWire;
  adopted: boolean;
  onAdopt: (u: ProxyUpstreamWire, accountName: string) => void;
  busy: boolean;
}) {
  const [adopting, setAdopting] = useState(false);
  // Seed the name from the email's local part — "work" from work@example.com —
  // since that is what the user calls this login anyway.
  const suggested = (u.email?.split("@")[0] ?? u.provider ?? "account")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 24);
  const [name, setName] = useState(suggested);
  const dot = u.disabled || u.unavailable ? "bg-muted-foreground/40" : "bg-emerald-500";
  return (
    <div className="space-y-1.5 px-1.5 py-1">
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
        {u.provider ?? "?"}
      </span>
      <span className="min-w-0 flex-1 truncate">{u.email ?? u.label ?? u.name}</span>
      {u.accountType && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {u.accountType}
        </Badge>
      )}
      {u.disabled && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          disabled
        </Badge>
      )}
      {u.prefix && (
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{u.prefix}/</Badge>
      )}
      {(u.success != null || u.failed != null) && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {u.success ?? 0}✓ {u.failed ?? 0}✗
        </span>
      )}
      {adopted ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">has an account</Badge>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5 text-[11px]"
          onClick={() => setAdopting((v) => !v)}
        >
          <PlusIcon className="size-3" /> Add as account
        </Button>
      )}
    </div>
    {adopting && !adopted && (
      <div className="flex items-center gap-1.5 pl-4">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="account name"
          className="h-7 w-40 font-mono text-xs"
        />
        <Button size="sm" className="h-7" disabled={!name.trim() || busy} onClick={() => onAdopt(u, name.trim())}>
          Create
        </Button>
        <span className="text-[11px] text-muted-foreground/70">
          pins this login as <code className="font-mono">{name.trim() || "…"}/</code> on the gateway
        </span>
      </div>
    )}
    </div>
  );
}

export function ProxyCard({
  proxy,
  onSaved,
  adoptedPrefixes = [],
  onAdopted,
}: {
  proxy: ProxyStatusWire;
  onSaved: (next: ProxyStatusWire) => void;
  // Prefixes already claimed by a Telar account, so a login that has one reads
  // as adopted rather than being offered again.
  adoptedPrefixes?: string[];
  onAdopted?: () => void;
}) {
  const [url, setUrl] = useState(proxy.url);
  const [apiKey, setApiKey] = useState("");
  const [mgmtKey, setMgmtKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The pool lives in the card, not in status — see ProxyStatusWire. `null`
  // means "not asked", which is a different thing from an empty pool.
  const [pool, setPool] = useState<ProxyUpstreamWire[] | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [breaker, setBreaker] = useState<ManagementBreakerWire>(proxy.management);
  const [poolBusy, setPoolBusy] = useState(false);

  // ONE management attempt per click, and only on a click. No mount effect, no
  // interval, no retry — each of those would extend the proxy's lockout rather
  // than recover from it.
  const loadPool = async () => {
    setPoolBusy(true);
    setPoolError(null);
    const r = await fetch("/api/proxy/pool", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    setPoolBusy(false);
    if (!r) {
      setPoolError("Could not reach Telar's proxy route.");
      return;
    }
    setPool(r.upstreams ?? null);
    setPoolError(r.error ?? null);
    if (r.management) setBreaker(r.management);
  };

  const post = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      const d = await r?.json().catch(() => ({}));
      setErr(d?.error ?? "Could not reach Telar's proxy settings.");
      return;
    }
    const d = await r.json();
    onSaved(d.proxy);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const save = () =>
    post({
      url,
      // Only send a key field the user actually typed into — an untouched box
      // must not clear a stored key.
      ...(apiKey ? { apiKey } : {}),
      ...(mgmtKey ? { managementKey: mgmtKey } : {}),
    }).then(() => {
      setApiKey("");
      setMgmtKey("");
    });

  const adopt = async (u: ProxyUpstreamWire, accountName: string) => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/proxy/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upstream: u.name,
        accountName,
        // Not a provider fork — a narrowing of the gateway's untrusted
        // free-text `provider` onto the union before it goes back out on a
        // wire. Nothing downstream behaves differently per arm; both are the
        // same assignment. Input validation wearing a ternary's clothes.
        provider: u.provider === "codex" ? "codex" : "claude",
      }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      const d = await r?.json().catch(() => ({}));
      setErr(d?.error ?? "Could not adopt that login.");
      return;
    }
    onAdopted?.();
    await loadPool();
  };

  const { claude, other } = splitModels(proxy.models);
  const statusDot = !proxy.enabled
    ? "bg-muted-foreground/40"
    : proxy.reachable
      ? "bg-emerald-500"
      : "bg-destructive";

  return (
    <Card size="sm">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
            <PlugIcon className="size-4 text-foreground/80" aria-hidden />
            <span
              className={cn(
                "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
                statusDot,
              )}
              aria-hidden
            />
          </span>
          <span className="text-sm font-medium">CLIProxyAPI</span>
          {proxy.enabled && proxy.reachable && (
            <Badge variant="secondary" className="text-[10px]">
              {proxy.models.length} models
            </Badge>
          )}
          {!proxy.enabled && (
            <Badge variant="outline" className="text-[10px]">
              off
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => post({})}
              disabled={busy}
              aria-label="Re-check the gateway"
            >
              <RotateCwIcon className={cn("size-3.5", busy && "animate-spin")} />
            </Button>
            <Switch
              checked={proxy.enabled}
              onCheckedChange={(c) => void post({ enabled: Boolean(c) })}
              aria-label="Enable CLIProxyAPI"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A local gateway that holds harness logins and re-exposes them as one API — it can serve
          Claude and GPT models to the same session. Entirely optional: accounts route through it
          only when they say so, and switching this off returns every account to talking to its
          provider directly.
        </p>

        {proxy.enabled && (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block sm:col-span-1">
                <span className="text-[11px] text-muted-foreground">URL</span>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8317"
                  className="mt-1 h-8 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-muted-foreground">
                  API key {proxy.hasApiKey && <span className="text-emerald-500">· set</span>}
                </span>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={proxy.hasApiKey ? "•••••• stored" : "sk-local-…"}
                  className="mt-1 h-8 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-muted-foreground">
                  Management key{" "}
                  {proxy.hasManagementKey && <span className="text-emerald-500">· set</span>}
                </span>
                <Input
                  type="password"
                  value={mgmtKey}
                  onChange={(e) => setMgmtKey(e.target.value)}
                  placeholder={proxy.hasManagementKey ? "•••••• stored" : "optional"}
                  className="mt-1 h-8 font-mono text-xs"
                />
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={busy}>
                {saved ? <CheckIcon className="size-3.5" /> : null} Save
              </Button>
              <span className="text-[11px] text-muted-foreground/70">
                Keys are stored in Telar&apos;s credential file and never sent back to this page.
              </span>
            </div>

            {(err || proxy.error) && (
              <p className={cn("text-xs", err ? "text-destructive" : "text-amber-500")}>
                {err ?? proxy.error}
              </p>
            )}

            {proxy.reachable && proxy.models.length > 0 && (
              <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
                Serving <span className="font-mono">{claude.length}</span> Claude and{" "}
                <span className="font-mono">{other.length}</span> other models
                {other.length > 0 && (
                  <>
                    {" "}
                    — including{" "}
                    <span className="font-mono">{other.slice(0, 3).join(", ")}</span>
                    {other.length > 3 && ` +${other.length - 3}`}
                  </>
                )}
                .
              </div>
            )}

            {/* THE POOL — loaded on demand only. Null means we never asked,
                which is a different statement from an empty pool, and both are
                worded as themselves rather than collapsed into "none". */}
            {proxy.reachable && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-foreground">Upstream logins</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={!proxy.hasManagementKey || poolBusy}
                    onClick={loadPool}
                  >
                    <RotateCwIcon className={cn("size-3", poolBusy && "animate-spin")} />
                    {pool === null ? "Load" : "Reload"}
                  </Button>
                  <span className="text-[10px] text-muted-foreground/60">
                    one management call per click
                  </span>
                </div>

                {/* The lockout, stated with its remedy. Retrying from here is
                    what makes it worse, so the card offers the restart instead
                    of a retry button. */}
                {breaker.blocked && (
                  <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                    <p className="text-[11px] text-destructive">{breaker.reason}</p>
                    <p className="text-[11px] text-muted-foreground">
                      The gateway locks out an IP after repeated management auth failures, and every
                      further request — even with the right key — extends it. Restart the proxy to
                      clear it:
                    </p>
                    <CopyCommand command={breaker.remedy} />
                  </div>
                )}
                {poolError && !breaker.blocked && (
                  <p className="text-[11px] text-amber-500">{poolError}</p>
                )}

                {pool === null ? (
                  <p className="text-[11px] text-muted-foreground/70">
                    {proxy.hasManagementKey
                      ? "Not loaded — press Load to ask the gateway which logins it holds."
                      : "Add the management key to list the logins this gateway holds."}
                  </p>
                ) : pool.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/70">
                    The gateway holds no logins yet.
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {pool.map((u) => (
                      <UpstreamRow
                        key={u.id || u.name}
                        u={u}
                        adopted={Boolean(u.prefix && adoptedPrefixes.includes(u.prefix))}
                        onAdopt={adopt}
                        busy={busy}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
