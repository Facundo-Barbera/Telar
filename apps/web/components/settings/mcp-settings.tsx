"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  Link2OffIcon,
  LinkIcon,
  PlusIcon,
  RotateCwIcon,
  SaveIcon,
  ServerIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

// The API returns plain JSON — we mirror the @telar/core shapes locally rather
// than importing types across the client boundary.
type McpSecretRefJson = { secret: string; prefix?: string };
type McpValueJson = string | McpSecretRefJson;
// Telar-owned OAuth block on an http server (schemas.ts McpOAuthConfig). Mirrored
// locally like the shapes above and carried through verbatim so editing/Saving a
// server never drops its auth config; the UI only reads auth.type to decide
// whether to render the Connect panel.
type McpAuthJson = {
  type: "oauth";
  scopes?: string[];
  clientId?: string;
  clientSecret?: McpSecretRefJson;
  authorizationServer?: string;
  redirectPath?: string;
};
type McpServerJson =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, McpValueJson>;
    }
  | {
      transport: "http";
      url: string;
      headers?: Record<string, McpValueJson>;
      auth?: McpAuthJson;
    };
type McpServersJson = Record<string, McpServerJson>;

// --- Editable form model. Each server/row carries a stable client id so React
// keys survive renaming the record key (the server name) or the entry key.
type Transport = "stdio" | "http";

type EntryRow = {
  id: number;
  keyName: string; // the env var / header name
  secret: boolean;
  literal: string; // value when secret is off
  secretKey: string; // secret store key when secret is on
  prefix: string; // optional literal prefix, e.g. "Bearer "
  token: string; // write-only token buffer — never loaded from the server
};

type Server = {
  id: number;
  key: string; // the record key = server name
  transport: Transport;
  command: string;
  args: string[];
  url: string;
  entries: EntryRow[]; // env (stdio) or headers (http)
  auth?: McpAuthJson; // http-only; preserved verbatim across edits/saves
};

let uid = 0;
const nextId = () => ++uid;

function rowsFromValues(values?: Record<string, McpValueJson>): EntryRow[] {
  if (!values) return [];
  return Object.entries(values).map(([keyName, v]) => {
    if (typeof v === "string") {
      return {
        id: nextId(),
        keyName,
        secret: false,
        literal: v,
        secretKey: "",
        prefix: "",
        token: "",
      };
    }
    return {
      id: nextId(),
      keyName,
      secret: true,
      literal: "",
      secretKey: v.secret,
      prefix: v.prefix ?? "",
      token: "",
    };
  });
}

function serversFromManifest(mcp: McpServersJson): Server[] {
  return Object.entries(mcp).map(([key, cfg]) => {
    if (cfg.transport === "http") {
      return {
        id: nextId(),
        key,
        transport: "http",
        command: "",
        args: [],
        url: cfg.url,
        entries: rowsFromValues(cfg.headers),
        auth: cfg.auth,
      };
    }
    return {
      id: nextId(),
      key,
      transport: "stdio",
      command: cfg.command,
      args: [...(cfg.args ?? [])],
      url: "",
      entries: rowsFromValues(cfg.env),
    };
  });
}

// Assemble the entry map (env/headers) from rows, skipping blank key names.
function valuesFromRows(rows: EntryRow[]): Record<string, McpValueJson> {
  const out: Record<string, McpValueJson> = {};
  for (const r of rows) {
    const k = r.keyName.trim();
    if (!k) continue;
    if (r.secret) {
      const secret = r.secretKey.trim();
      if (!secret) continue;
      out[k] = r.prefix ? { secret, prefix: r.prefix } : { secret };
    } else {
      out[k] = r.literal;
    }
  }
  return out;
}

// Assemble the mcpServers record for the PATCH body, skipping blank server
// names. Empty env/headers are omitted so a bare server round-trips cleanly.
function assemble(servers: Server[]): McpServersJson {
  const out: McpServersJson = {};
  for (const s of servers) {
    const key = s.key.trim();
    if (!key) continue;
    if (s.transport === "http") {
      const headers = valuesFromRows(s.entries);
      out[key] = {
        transport: "http",
        url: s.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(s.auth ? { auth: s.auth } : {}),
      };
    } else {
      const env = valuesFromRows(s.entries);
      out[key] = {
        transport: "stdio",
        command: s.command,
        args: s.args.map((a) => a.trim()).filter(Boolean),
        ...(Object.keys(env).length ? { env } : {}),
      };
    }
  }
  return out;
}

function newServer(): Server {
  return {
    id: nextId(),
    key: "new-server",
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    entries: [],
  };
}

function newRow(): EntryRow {
  return {
    id: nextId(),
    keyName: "",
    secret: false,
    literal: "",
    secretKey: "",
    prefix: "",
    token: "",
  };
}

// Local twins of the settings-view helpers — kept private so this card stays
// self-contained and matches the surrounding spacing/typography.
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function StringListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
  emptyLabel,
  ariaPrefix,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  emptyLabel: string;
  ariaPrefix: string;
}) {
  return (
    <div className="space-y-2">
      {values.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      )}
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) =>
              onChange(values.map((v, idx) => (idx === i ? e.target.value : v)))
            }
            placeholder={placeholder}
            className="h-8 flex-1 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${ariaPrefix} ${i + 1}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
            aria-label={`Remove ${ariaPrefix.toLowerCase()} ${i + 1}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...values, ""])}
      >
        <PlusIcon />
        {addLabel}
      </Button>
    </div>
  );
}

// One env var / header row. Token operations hit the /mcp route immediately and
// are independent of the manifest Save.
function EntryEditor({
  server,
  row,
  hasToken,
  onChange,
  onRemove,
  onSetToken,
  onClearToken,
  busyToken,
}: {
  server: Server;
  row: EntryRow;
  hasToken: boolean;
  onChange: (patch: Partial<EntryRow>) => void;
  onRemove: () => void;
  onSetToken: () => void;
  onClearToken: () => void;
  busyToken: boolean;
}) {
  const noun = server.transport === "http" ? "Header" : "Env var";
  return (
    <div className="space-y-2 rounded-md border border-border p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={row.keyName}
          onChange={(e) => onChange({ keyName: e.target.value })}
          placeholder={server.transport === "http" ? "Authorization" : "API_KEY"}
          className="h-8 flex-1 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${noun} name`}
        />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={row.secret}
            onCheckedChange={(v) => onChange({ secret: v === true })}
            aria-label="Store as secret"
          />
          secret
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${noun.toLowerCase()}`}
        >
          <XIcon />
        </Button>
      </div>

      {!row.secret ? (
        <Input
          value={row.literal}
          onChange={(e) => onChange({ literal: e.target.value })}
          placeholder="value"
          className="h-8 w-full font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${noun} value`}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={row.secretKey}
              onChange={(e) => onChange({ secretKey: e.target.value })}
              placeholder="secret key"
              className="h-8 flex-1 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${noun} secret key`}
            />
            <Input
              value={row.prefix}
              onChange={(e) => onChange({ prefix: e.target.value })}
              placeholder="prefix (e.g. Bearer )"
              className="h-8 w-40 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${noun} prefix`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={hasToken ? "default" : "outline"} className="text-[10px]">
              {hasToken ? "token set" : "no token"}
            </Badge>
            <Input
              type="password"
              value={row.token}
              onChange={(e) => onChange({ token: e.target.value })}
              placeholder={hasToken ? "enter new token" : "enter token"}
              className="h-8 flex-1 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              aria-label="Token value"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSetToken}
              disabled={busyToken || !row.secretKey.trim() || !row.token}
            >
              {busyToken ? <Spinner /> : null}
              {hasToken ? "Update" : "Set"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onClearToken}
              disabled={busyToken || !hasToken}
            >
              Clear
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Tokens are stored locally the moment you press Set/Update — separate
            from the manifest Save below, which never touches token values.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Telar-owned OAuth connection (docs/mcp-oauth-design.md §5). One panel per
// http server whose config has auth.type === "oauth". Connect/Reconnect POST to
// the connect route to derive the authorization URL server-side, then navigate
// the browser to it (the OAuth redirect flow leaves the SPA to hit the
// authorization server and returns via the callback route); Disconnect + status
// are same-origin fetches. Status is best-effort — unknown ⇒ just show "Connect".
type OAuthStatus = "connected" | "expired";

// Tolerant read of the status route so the UI survives whatever exact shape the
// oauth routes expose (they may not exist yet): a bare "connected"/"expired"
// string per server, or a { connected, expired } object. Anything unrecognized
// is omitted, which the panels render as "Connect".
function normalizeOAuthStatus(raw: unknown): Record<string, OAuthStatus> {
  const src = (raw as { servers?: Record<string, unknown> } | null)?.servers;
  if (!src || typeof src !== "object") return {};
  const out: Record<string, OAuthStatus> = {};
  for (const [server, v] of Object.entries(src)) {
    if (v === "connected" || v === "expired") out[server] = v;
    else if (v && typeof v === "object") {
      const o = v as { connected?: boolean; expired?: boolean };
      if (o.expired) out[server] = "expired";
      else if (o.connected) out[server] = "connected";
    }
  }
  return out;
}

function OAuthConnect({
  status,
  busy,
  onConnect,
  onDisconnect,
}: {
  status?: OAuthStatus;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">
          OAuth connection
        </span>
        {status === "connected" && (
          <Badge variant="secondary" className="text-[10px]">
            <CheckCircle2Icon />
            Connected
          </Badge>
        )}
        {status === "expired" && (
          <Badge variant="destructive" className="text-[10px]">
            <TriangleAlertIcon />
            Expired
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {status ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onConnect}
                disabled={busy}
              >
                <RotateCwIcon />
                Reconnect
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={onDisconnect}
                disabled={busy}
              >
                {busy ? <Spinner /> : <Link2OffIcon />}
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onConnect}
              disabled={busy}
            >
              <LinkIcon />
              Connect
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {status
          ? "Telar owns this server's login and injects the token for every execution account — no header needed."
          : "Connect once; Telar manages the OAuth login and injects the token for every account and session."}
      </p>
    </div>
  );
}

export function McpSettings({ name }: { name: string }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [origServers, setOrigServers] = useState<McpServersJson>({});
  const [tokens, setTokens] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busyToken, setBusyToken] = useState<number | null>(null);

  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>(
    {},
  );
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthNotice, setOauthNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [projRes, mcpRes] = await Promise.all([
        fetch("/api/projects"),
        fetch(`/api/projects/${encodeURIComponent(name)}/mcp`),
      ]);
      if (!projRes.ok)
        throw new Error(`Couldn't reach the registry (${projRes.status}).`);
      const projData = (await projRes.json()) as {
        projects?: {
          entry: { name: string };
          manifest: { mcpServers?: McpServersJson } | null;
        }[];
      };
      const match = (projData.projects ?? []).find(
        (p) => p.entry.name === name,
      );
      const mcp = match?.manifest?.mcpServers ?? {};
      setServers(serversFromManifest(mcp));
      setOrigServers(assemble(serversFromManifest(mcp)));

      // The has-token map is best-effort — a missing route shouldn't block editing.
      if (mcpRes.ok) {
        const mcpData = (await mcpRes.json()) as {
          tokens?: Record<string, boolean>;
        };
        setTokens(mcpData.tokens ?? {});
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setServers(null);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  // Best-effort OAuth connection status per server. A missing/!ok route (the
  // oauth routes may not be up yet) leaves the map empty → panels show "Connect".
  const loadOAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/mcp/oauth/status?project=${encodeURIComponent(name)}`,
      );
      if (!res.ok) return;
      setOauthStatus(normalizeOAuthStatus(await res.json()));
    } catch {
      // status unknown — panels fall back to "Connect"
    }
  }, [name]);

  useEffect(() => {
    void loadOAuthStatus();
  }, [loadOAuthStatus]);

  // The callback route redirects back here with ?mcpConnected=<server> on
  // success or ?mcpOAuthError=<message> on failure (the message already names
  // the server). Surface it inline, then scrub the query so a refresh doesn't
  // replay it. On success, re-pull status so the pill flips live.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("mcpConnected");
    const error = params.get("mcpOAuthError");
    if (!connected && !error) return;
    setOauthNotice(
      error
        ? { kind: "error", text: error }
        : {
            kind: "success",
            text: connected ? `Connected ${connected}.` : "MCP server connected.",
          },
    );
    for (const k of ["mcpConnected", "mcpOAuthError"]) params.delete(k);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    if (connected) void loadOAuthStatus();
  }, [loadOAuthStatus]);

  const refreshTokens = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}/mcp`);
      if (!res.ok) return;
      const data = (await res.json()) as { tokens?: Record<string, boolean> };
      setTokens(data.tokens ?? {});
    } catch {
      // ignore — the badge simply keeps its last known state
    }
  }, [name]);

  const dirty = useMemo(
    () =>
      servers !== null &&
      JSON.stringify(assemble(servers)) !== JSON.stringify(origServers),
    [servers, origServers],
  );

  // Tokens typed into a password field but not yet committed via Set/Update.
  // Save never persists these and rebuilds rows on success (wiping the buffer),
  // so we surface a warning rather than let the value vanish silently.
  const pendingTokens = useMemo(
    () =>
      (servers ?? []).some((s) =>
        s.entries.some((r) => r.secret && r.secretKey.trim() && r.token),
      ),
    [servers],
  );

  useEffect(() => {
    if (dirty) {
      setSaved(false);
      setSaveError(null);
      setConflict(false);
    }
  }, [dirty]);

  const patchServer = (id: number, patch: Partial<Server>) =>
    setServers((prev) =>
      prev
        ? prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
        : prev,
    );

  const patchRow = (rowId: number, patch: Partial<EntryRow>) =>
    setServers((prev) =>
      prev
        ? prev.map((s) => ({
            ...s,
            entries: s.entries.map((r) =>
              r.id === rowId ? { ...r, ...patch } : r,
            ),
          }))
        : prev,
    );

  const setToken = async (row: EntryRow) => {
    const key = row.secretKey.trim();
    if (!key || !row.token) return;
    setBusyToken(row.id);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, token: row.token }),
      });
      patchRow(row.id, { token: "" });
      await refreshTokens();
    } catch {
      // best-effort — refreshTokens reflects the true persisted state
    } finally {
      setBusyToken(null);
    }
  };

  const clearToken = async (row: EntryRow) => {
    const key = row.secretKey.trim();
    if (!key) return;
    if (
      !window.confirm(
        `Delete the stored token for "${key}"? This happens immediately and can't be undone.`,
      )
    )
      return;
    setBusyToken(row.id);
    try {
      await fetch(`/api/projects/${encodeURIComponent(name)}/mcp`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      await refreshTokens();
    } catch {
      // best-effort
    } finally {
      setBusyToken(null);
    }
  };

  // Start the browser OAuth flow: POST to derive the authorization URL entirely
  // server-side (the connect route only accepts POST), then navigate the browser
  // to it. On success we leave the SPA and return via the callback route; only
  // failures come back here to surface as a notice.
  const connect = async (server: string) => {
    setOauthBusy(server);
    setOauthNotice(null);
    try {
      const res = await fetch("/api/mcp/oauth/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: name, server }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(
          data.error ?? `Couldn't start OAuth connect (${res.status}).`,
        );
      }
      window.location.href = data.url;
    } catch (e) {
      setOauthNotice({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
      setOauthBusy(null);
    }
  };

  const disconnect = async (server: string) => {
    if (
      !window.confirm(
        `Disconnect OAuth for "${server}"? Telar forgets the stored token immediately; you can reconnect anytime.`,
      )
    )
      return;
    setOauthBusy(server);
    try {
      await fetch("/api/mcp/oauth/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: name, server }),
      });
      await loadOAuthStatus();
    } catch {
      // best-effort — loadOAuthStatus reflects the true persisted state
    } finally {
      setOauthBusy(null);
    }
  };

  const save = async () => {
    if (!servers) return;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpServers: assemble(servers) }),
      });
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        manifest?: { mcpServers?: McpServersJson };
      };
      if (!res.ok || !data.manifest)
        throw new Error(data.error ?? `Save failed (${res.status}).`);

      const mcp = data.manifest.mcpServers ?? {};
      setServers(serversFromManifest(mcp));
      setOrigServers(assemble(serversFromManifest(mcp)));
      setSaved(true);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ServerIcon className="size-4 text-muted-foreground" />
          MCP servers
        </CardTitle>
        <CardDescription>
          Servers available to this project&apos;s sessions and looms; tokens are
          stored locally, never in the repo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {saved && (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>MCP servers saved</AlertTitle>
          </Alert>
        )}
        {conflict && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Changed elsewhere</AlertTitle>
            <AlertDescription>
              telar.yaml was modified since it loaded — reload to pick up the
              latest before saving again.
            </AlertDescription>
          </Alert>
        )}
        {saveError && (
          <Alert variant="destructive">
            <XIcon />
            <AlertTitle>Couldn&apos;t save</AlertTitle>
            <AlertDescription className="font-mono text-xs break-words">
              {saveError}
            </AlertDescription>
          </Alert>
        )}
        {oauthNotice &&
          (oauthNotice.kind === "error" ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>OAuth connection failed</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">
                {oauthNotice.text}
              </AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOauthNotice(null)}
                  aria-label="Dismiss"
                >
                  <XIcon />
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>{oauthNotice.text}</AlertTitle>
              <AlertAction>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOauthNotice(null)}
                  aria-label="Dismiss"
                >
                  <XIcon />
                </Button>
              </AlertAction>
            </Alert>
          ))}

        {servers === null ? (
          loadError ? (
            <div className="space-y-3">
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Couldn&apos;t load MCP servers</AlertTitle>
                <AlertDescription className="font-mono text-xs break-words">
                  {loadError}
                </AlertDescription>
              </Alert>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-3/4 rounded-lg" />
            </div>
          )
        ) : (
          <>
            {servers.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                No MCP servers — sessions run with the loom&apos;s built-in tools
                only.
              </p>
            )}

            {servers.map((server) => (
              <div
                key={server.id}
                className="space-y-3 rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={server.key}
                    onChange={(e) =>
                      patchServer(server.id, { key: e.target.value })
                    }
                    placeholder="server-name"
                    className="h-8 flex-1 font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Server name"
                  />
                  <Select
                    value={server.transport}
                    onValueChange={(v) =>
                      v &&
                      patchServer(server.id, {
                        transport: String(v) as Transport,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio</SelectItem>
                      <SelectItem value="http">http</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setServers((prev) =>
                        prev
                          ? prev.filter((s) => s.id !== server.id)
                          : prev,
                      )
                    }
                    aria-label={`Remove server ${server.key}`}
                  >
                    <XIcon />
                  </Button>
                </div>

                {server.transport === "stdio" ? (
                  <>
                    <Field label="Command">
                      <Input
                        value={server.command}
                        onChange={(e) =>
                          patchServer(server.id, { command: e.target.value })
                        }
                        placeholder="npx"
                        className="h-8 font-mono text-xs"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="Args">
                      <StringListEditor
                        values={server.args}
                        onChange={(args) => patchServer(server.id, { args })}
                        placeholder="-y"
                        addLabel="Add arg"
                        emptyLabel="No args."
                        ariaPrefix="Arg"
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="URL">
                    <Input
                      value={server.url}
                      onChange={(e) =>
                        patchServer(server.id, { url: e.target.value })
                      }
                      placeholder="https://mcp.example.com"
                      className="h-8 font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                )}

                {server.transport === "http" &&
                  server.auth?.type === "oauth" && (
                    <OAuthConnect
                      status={oauthStatus[server.key]}
                      busy={oauthBusy === server.key}
                      onConnect={() => void connect(server.key)}
                      onDisconnect={() => void disconnect(server.key)}
                    />
                  )}

                <Field
                  label={server.transport === "http" ? "Headers" : "Environment"}
                >
                  <div className="space-y-2">
                    {server.entries.length === 0 && (
                      <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                        {server.transport === "http"
                          ? "No headers."
                          : "No environment variables."}
                      </p>
                    )}
                    {server.entries.map((row) => (
                      <EntryEditor
                        key={row.id}
                        server={server}
                        row={row}
                        hasToken={
                          !!row.secretKey.trim() &&
                          !!tokens[row.secretKey.trim()]
                        }
                        busyToken={busyToken === row.id}
                        onChange={(patch) => patchRow(row.id, patch)}
                        onRemove={() =>
                          patchServer(server.id, {
                            entries: server.entries.filter(
                              (r) => r.id !== row.id,
                            ),
                          })
                        }
                        onSetToken={() => void setToken(row)}
                        onClearToken={() => void clearToken(row)}
                      />
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        patchServer(server.id, {
                          entries: [...server.entries, newRow()],
                        })
                      }
                    >
                      <PlusIcon />
                      {server.transport === "http" ? "Add header" : "Add env"}
                    </Button>
                  </div>
                </Field>
              </div>
            ))}

            {pendingTokens && (
              <Alert>
                <TriangleAlertIcon />
                <AlertTitle>Un-saved token</AlertTitle>
                <AlertDescription>
                  You&apos;ve typed a token that isn&apos;t stored yet. Press
                  Set/Update on that row to save it — the manifest Save below
                  won&apos;t persist typed tokens.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setServers((prev) => [...(prev ?? []), newServer()])
                }
              >
                <PlusIcon />
                Add server
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!dirty || saving}
              >
                {saving ? <Spinner /> : <SaveIcon />}
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
