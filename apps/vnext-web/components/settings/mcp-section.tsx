"use client";

/**
 * The user's own MCP servers.
 *
 * WHAT THIS IS NOT: Telar's in-process capabilities. Those are named
 * `mcp__telar__<capability>_<verb>`, the engine vouches for them, and there is
 * nothing here to configure. One of these is a THIRD PARTY the user pointed at
 * — a command that gets spawned, or a URL that gets called with their headers —
 * so it is created, disabled and deleted explicitly, and the form says which of
 * those three things it is.
 *
 * THE ID IS NOT DECORATION. It becomes the server's name to the provider, which
 * makes its tools `mcp__<id>__<tool>` — the string that correlates a timeline
 * row with its approval. So it is constrained to an id and cannot be edited
 * afterwards: renaming one would orphan every row that already named it.
 */

import { useCallback, useEffect, useState } from "react";
import { GlobeIcon, PlugIcon, TerminalIcon, Trash2Icon } from "lucide-react";
import type { McpServer, McpServerSpec } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";

const api = createVNextApi();

type Transport = McpServerSpec["transport"];

const TRANSPORTS: { id: Transport; label: string; hint: string }[] = [
  { id: "stdio", label: "Command", hint: "A local process the worker spawns and talks to over stdio." },
  { id: "http", label: "HTTP", hint: "A server reachable over HTTP, streamable." },
  { id: "sse", label: "SSE", hint: "A server that streams over server-sent events." },
];

/** What a configured server says about itself, in one line. */
function describe(spec: McpServerSpec): string {
  if (spec.transport === "stdio") return [spec.command, ...(spec.args ?? [])].join(" ");
  return spec.url;
}

function ServerRow({ server, onChange }: { server: McpServer; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      icon={server.spec.transport === "stdio" ? TerminalIcon : GlobeIcon}
      label={server.label}
      hint={describe(server.spec)}
      control={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">
            {server.id}
          </Badge>
          {/* Off is a state, not deletion — a server that is failing should be
              silenceable without losing how it was configured. */}
          <Switch
            checked={server.enabled}
            disabled={busy}
            aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.label}`}
            onCheckedChange={(next) => void act(() => api.saveMcpServer({ id: server.id, enabled: next, spec: server.spec }))}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${server.label}`}
            disabled={busy}
            onClick={() => void act(() => api.removeMcpServer(server.id))}
          >
            <Trash2Icon />
          </Button>
        </div>
      }
    />
  );
}

function AddServerForm({ onAdded }: { onAdded: () => void }) {
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
      // The command is split on whitespace here rather than asking for argv as
      // a second field: `node server.js --port 9000` is how anyone would type
      // it, and a form that refused that shape would be arguing with the user.
      const [command, ...args] = target.trim().split(/\s+/);
      const spec: McpServerSpec =
        transport === "stdio"
          ? { transport, command: command ?? "", ...(args.length > 0 ? { args } : {}) }
          : { transport, url: target.trim() };
      await api.saveMcpServer({ id: id.trim(), ...(label.trim() ? { label: label.trim() } : {}), spec });
      setId("");
      setLabel("");
      setTarget("");
      onAdded();
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : "That server could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Add a server" description="Every enabled server is offered to every session this environment runs.">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {TRANSPORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setTransport(option.id)}
              title={option.hint}
              className={
                transport === option.id
                  ? "rounded-md border border-ring bg-accent px-2.5 py-1 text-xs font-medium"
                  : "rounded-md border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
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
        <p className="text-[11px] leading-snug text-muted-foreground">
          The id becomes the server&rsquo;s name to the provider, so its tools arrive as <code className="font-mono">mcp__{id.trim() || "id"}__*</code>.
          Letters, numbers, dashes and underscores only, and it cannot be changed afterwards.
        </p>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        <div>
          <Button type="button" size="sm" disabled={busy || !id.trim() || !target.trim()} onClick={() => void save()}>
            Add server
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

export function McpSection() {
  const [servers, setServers] = useState<McpServer[]>();
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    try {
      setServers((await api.mcpServers()).mcpServers);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return (
    <>
      <SettingsGroup
        title="MCP servers"
        description="Tool servers you configured. Stored once for this machine, not per conversation, and handed to every session the engine claims a turn for."
      >
        {unreachable ? (
          <Row label="The engine did not answer" hint="Start it with the launcher, using the same TELAR_HOME." control={<Badge variant="outline">Offline</Badge>} />
        ) : servers === undefined ? (
          <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
        ) : servers.length === 0 ? (
          <Row
            icon={PlugIcon}
            label="No servers configured"
            hint="Telar's own capabilities — the browser, and whatever comes after it — are always present and are not listed here."
            control={<Badge variant="outline">None</Badge>}
          />
        ) : (
          servers.map((server) => <ServerRow key={server.id} server={server} onChange={() => void load()} />)
        )}
      </SettingsGroup>

      <AddServerForm onAdded={() => void load()} />

      {/* A GAP NAMED AT THE POINT IT BITES. Codex owns its own MCP registry
          through ~/.codex/config.toml and the shape its app-server accepts for
          servers is not something the driver can verify against anything —
          guessing it would fail the whole turn. See apps/engine/src/codex-driver.ts. */}
      <SettingsGroup title="Which sessions see these" description="One provider reads this list; the other reads its own.">
        <Row label="Claude sessions" hint="Every enabled server above is passed to the Agent SDK for each turn." control={<Badge variant="secondary">Applied</Badge>} />
        <Row
          label="Codex sessions"
          hint="Codex reads its own ~/.codex/config.toml. Servers configured here are not passed to it."
          control={<Badge variant="outline">Not applied</Badge>}
        />
      </SettingsGroup>
    </>
  );
}
