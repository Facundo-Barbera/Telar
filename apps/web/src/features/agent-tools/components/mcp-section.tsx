"use client";

import { useCallback, useEffect, useState } from "react";
import { GlobeIcon, PlugIcon, PlusIcon, Settings2Icon, TerminalIcon, XIcon } from "lucide-react";
import type { McpOAuthStatus, McpServer, McpServerSpec } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { cn } from "@/ui/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { Row, Segmented, SettingsGroup } from "@/features/settings";
import { HEALTH_DOT, signInAction, signInSummary, statusFor } from "../mcp-oauth";

const api = createEngineApi();

type Transport = McpServerSpec["transport"];

export type McpScope = { projectId: string; projectName: string } | undefined;

const TRANSPORTS: { id: Transport; label: string; hint: string }[] = [
  { id: "stdio", label: "Command", hint: "A local process the worker spawns and talks to over stdio." },
  { id: "http", label: "HTTP", hint: "A server reachable over HTTP, streamable." },
  { id: "sse", label: "SSE", hint: "A server that streams over server-sent events." },
];

function describe(spec: McpServerSpec): string {
  if (spec.transport === "stdio") return [spec.command, ...(spec.args ?? [])].join(" ");
  return spec.url;
}

function ServerRow({
  server,
  scope,
  status,
  awaiting,
  onAwait,
  onChange,
}: {
  server: McpServer;
  scope: McpScope;
  status?: McpOAuthStatus;
  awaiting: boolean;
  onAwait: (serverId: string) => void;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      onChange();
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const action = signInAction(status);
  const signIn = () =>
    act(async () => {
      const { authorizationUrl } = await api.connectMcpOAuth(server.id, scope?.projectId);
      onAwait(server.id);
      window.location.assign(authorizationUrl);
    });

  return (
    <>
      <Row
        icon={server.spec.transport === "stdio" ? TerminalIcon : GlobeIcon}
        label={server.label}
        hint={describe(server.spec)}
        control={
          <div className="flex items-center gap-2">
            {awaiting ? (
              <span className="text-2xs text-muted-foreground">Finish signing in, in your browser…</span>
            ) : (
              (action === "connect" || action === "reconnect") && (
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void signIn()}>
                  {action === "connect" ? "Sign in" : "Sign in again"}
                </Button>
              )
            )}
            {status && (status.connected || status.requiresOAuth) && (
              <span
                title={signInSummary(status)}
                aria-label={signInSummary(status)}
                className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[status.health])}
              />
            )}
            <Badge variant="outline" className="font-mono text-3xs">
              {server.id}
            </Badge>
            <Switch
              checked={server.enabled}
              disabled={busy}
              aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.label}`}
              onCheckedChange={(next) =>
                void act(() =>
                  api.saveMcpServer({ id: server.id, ...(scope ? { projectId: scope.projectId } : {}), enabled: next, spec: server.spec }),
                )
              }
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Configure ${server.label}`}
              onClick={() => setConfiguring((open) => !open)}
            >
              <Settings2Icon />
            </Button>
          </div>
        }
      />
      {configuring && (
        <div className="space-y-2 rounded-md bg-muted/20 px-3 py-2">
          {status && (status.connected || status.requiresOAuth) && (
            <p className="text-2xs leading-snug text-muted-foreground">
              {signInSummary(status)}
              {status.scope && (
                <>
                  {" "}
                  Scopes: <code className="font-mono">{status.scope}</code>.
                </>
              )}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-muted-foreground">
              The id cannot change — every timeline row that already named{" "}
              <code className="font-mono">mcp__{server.id}__*</code> would be orphaned. Remove it and add it again instead.
            </p>
            <div className="flex shrink-0 items-center gap-1">
              {action === "disconnect" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={busy}
                  onClick={() => void act(() => api.disconnectMcpOAuth(server.id, scope?.projectId))}
                >
                  Sign out
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Remove "${server.label}"? Sessions stop being offered its tools. The server itself is not touched.`)) return;
                  void act(() => api.removeMcpServer(server.id, scope?.projectId));
                }}
              >
                <XIcon />
                Remove
              </Button>
            </div>
          </div>
          {error && <p className="text-2xs text-destructive">{error}</p>}
        </div>
      )}
    </>
  );
}

function AddServerForm({ scope, onAdded, onClose }: { scope: McpScope; onAdded: () => void; onClose: () => void }) {
  const [transport, setTransport] = useState<Transport>("stdio");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const [command, ...args] = target.trim().split(/\s+/);
      const spec: McpServerSpec =
        transport === "stdio"
          ? { transport, command: command ?? "", ...(args.length > 0 ? { args } : {}) }
          : { transport, url: target.trim() };
      await api.saveMcpServer({
        id: id.trim(),
        ...(scope ? { projectId: scope.projectId } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        spec,
      });
      setId("");
      setLabel("");
      setTarget("");
      onAdded();
      onClose();
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "That server could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="Add a server"
      description={
        scope
          ? `Offered to every session on ${scope.projectName}, and to no other project. An id that matches a machine-wide server replaces it here.`
          : "Offered to every session on every project, unless a project defines one with the same id."
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <Segmented<Transport>
          value={transport}
          onChange={setTransport}
          options={TRANSPORTS.map((option) => ({ value: option.id, label: <span title={option.hint}>{option.label}</span> }))}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="linear"
            aria-label="Server id"
            className="font-mono text-sm"
          />
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Linear (optional label)" aria-label="Server label" />
        </div>
        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={transport === "stdio" ? "node ./my-mcp-server.js" : "https://mcp.example.com/sse"}
          aria-label={transport === "stdio" ? "Command" : "URL"}
          className="font-mono text-sm"
        />
        <p className="text-2xs leading-snug text-muted-foreground">
          The id becomes the server&rsquo;s name to the provider, so its tools arrive as <code className="font-mono">mcp__{id.trim() || "id"}__*</code>.
          Letters, numbers, dashes and underscores. Cannot be changed later.
        </p>
        {error && <p className="text-2xs text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !id.trim() || !target.trim()} onClick={() => void save()}>
            Add server
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

export function McpSection({ scope }: { scope?: McpScope } = {}) {
  const [servers, setServers] = useState<McpServer[]>();
  const [inherited, setInherited] = useState<McpServer[]>([]);
  const [statuses, setStatuses] = useState<McpOAuthStatus[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<{ connected?: string; error?: string }>();
  const [awaiting, setAwaiting] = useState<string>();

  const projectId = scope?.projectId;

  const load = useCallback(async () => {
    try {
      if (projectId) {
        const answer = await api.projectMcpServers(projectId);
        setServers(answer.mcpServers);
        setInherited(answer.effective.filter((server) => server.projectId === undefined));
      } else {
        setServers((await api.mcpServers()).mcpServers);
      }
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, [projectId]);

  const loadStatuses = useCallback(async () => {
    try {
      const { statuses: next } = await api.mcpOAuthStatus(projectId);
      setStatuses(next);
      setAwaiting((watched) => (watched && next.some((status) => status.serverId === watched && status.connected) ? undefined : watched));
    } catch {
      setStatuses([]);
    }
  }, [projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
      void loadStatuses();
    }, 0);
    return () => window.clearTimeout(task);
  }, [load, loadStatuses]);

  useEffect(() => {
    if (!awaiting) return;
    const started = Date.now();
    const check = () => {
      if (Date.now() - started > 120_000) {
        setAwaiting(undefined);
        return;
      }
      void loadStatuses();
    };
    const timer = window.setInterval(check, 2_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [awaiting, loadStatuses]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      const query = new URLSearchParams(window.location.search);
      const connected = query.get("mcpConnected");
      const error = query.get("mcpOAuthError");
      if (!connected && !error) return;
      setOutcome({ ...(connected ? { connected } : {}), ...(error ? { error } : {}) });
      query.delete("mcpConnected");
      query.delete("mcpOAuthError");
      const rest = query.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  return (
    <>
      {outcome && (
        <SettingsGroup title="Sign-in">
          <Row
            label={outcome.error ? "That sign-in did not finish" : `Signed in to ${outcome.connected}`}
            hint={outcome.error ?? "Sessions on this scope now reach it as you."}
            control={<Badge variant={outcome.error ? "outline" : "secondary"}>{outcome.error ? "Failed" : "Connected"}</Badge>}
          />
        </SettingsGroup>
      )}

      <SettingsGroup
        title={scope ? `${scope.projectName}'s servers` : "Machine-wide servers"}
        description={
          scope
            ? "Tool servers only this project's sessions see."
            : "Tool servers every project sees."
        }
        {...(adding
          ? {}
          : {
              action: (
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <PlusIcon className="size-3.5" />
                  Add
                </Button>
              ),
            })}
      >
        {unreachable ? (
          <Row label="The engine did not answer" hint="Start it with the launcher, using the same TELAR_HOME." control={<Badge variant="outline">Offline</Badge>} />
        ) : servers === undefined ? (
          <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
        ) : servers.length === 0 ? (
          <Row icon={PlugIcon} label="No servers configured" hint="Telar's own tools are always available and not listed here." />
        ) : (
          servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              scope={scope}
              {...(statusFor(statuses, server) ? { status: statusFor(statuses, server)! } : {})}
              awaiting={awaiting === server.id}
              onAwait={setAwaiting}
              onChange={() => {
                void load();
                void loadStatuses();
              }}
            />
          ))
        )}
      </SettingsGroup>

      {adding && <AddServerForm scope={scope} onAdded={() => void load()} onClose={() => setAdding(false)} />}

      {scope && inherited.length > 0 && (
        <SettingsGroup title="Also in play here" description="Machine-wide servers this project has not replaced.">
          {inherited.map((server) => (
            <Row
              key={server.id}
              icon={server.spec.transport === "stdio" ? TerminalIcon : GlobeIcon}
              label={server.label}
              hint={describe(server.spec)}
              control={<Badge variant={server.enabled ? "secondary" : "outline"}>{server.enabled ? "Machine-wide" : "Off"}</Badge>}
            />
          ))}
        </SettingsGroup>
      )}

    </>
  );
}
