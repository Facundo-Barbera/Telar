"use client";

/**
 * The user's own MCP servers, in one scope.
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
 *
 * TWO SCOPES, ONE COMPONENT. This file used to assert that MCP servers are
 * "stored once for this machine, not per conversation" — the second half right,
 * the conclusion wrong. An MCP server is usually a thing about a CODEBASE, and
 * the legacy cockpit had that right: its servers lived in each project's own
 * manifest. Both scopes exist now and the component takes one, so the machine's
 * list in Settings and a project's list in its own settings page are the same
 * surface rather than two that drift.
 *
 * CARD SHAPE PORTED FROM `apps/web_old/components/settings/mcp-settings.tsx`:
 * compact by default — name, what it points at, a switch and a gear — with the
 * full editor behind Configure. The donor's OAuth Connect button is NOT here
 * yet; see the note at the foot of this file.
 */

import { useCallback, useEffect, useState } from "react";
import { GlobeIcon, PlugIcon, Settings2Icon, TerminalIcon, XIcon } from "lucide-react";
import type { McpServer, McpServerSpec } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";

const api = createVNextApi();

type Transport = McpServerSpec["transport"];

/**
 * WHICH SET OF SERVERS this pane is editing. `undefined` is the machine's.
 *
 * Passed explicitly rather than inferred from the route, so the component
 * cannot be mounted somewhere that leaves it guessing — a pane that guessed
 * would write a project's server into the global list, which is the one mistake
 * here that is invisible until a different repo grows a tool it never asked for.
 */
export type McpScope = { projectId: string; projectName: string } | undefined;

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

function ServerRow({ server, scope, onChange }: { server: McpServer; scope: McpScope; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [configuring, setConfiguring] = useState(false);
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
    <>
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
        <div className="flex items-center justify-between gap-2 bg-muted/20 px-4 py-2">
          <p className="text-[11px] text-muted-foreground">
            The id cannot change — every timeline row that already named{" "}
            <code className="font-mono">mcp__{server.id}__*</code> would be orphaned. Remove it and add it again instead.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Remove "${server.label}"? Sessions stop being offered its tools.`)) return;
              void act(() => api.removeMcpServer(server.id, scope?.projectId));
            }}
          >
            <XIcon />
            Remove
          </Button>
        </div>
      )}
    </>
  );
}

function AddServerForm({ scope, onAdded }: { scope: McpScope; onAdded: () => void }) {
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
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : "That server could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="Add a server"
      description={
        scope
          ? `Offered to every session on ${scope.projectName}, and to no other project.`
          : "Offered to every session on every project, unless a project defines one with the same id."
      }
    >
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

export function McpSection({ scope }: { scope?: McpScope } = {}) {
  const [servers, setServers] = useState<McpServer[]>();
  const [inherited, setInherited] = useState<McpServer[]>([]);
  const [unreachable, setUnreachable] = useState(false);

  // Keyed on the ID, not on the object: a parent rebuilding `{projectId, name}`
  // each render would otherwise give `load` a new identity every paint and turn
  // the effect below into a fetch loop.
  const projectId = scope?.projectId;

  const load = useCallback(async () => {
    try {
      if (projectId) {
        const answer = await api.projectMcpServers(projectId);
        setServers(answer.mcpServers);
        // `effective` has already dropped the globals this project shadows, so
        // what is left of them is exactly what it INHERITS.
        setInherited(answer.effective.filter((server) => server.projectId === undefined));
      } else {
        setServers((await api.mcpServers()).mcpServers);
      }
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, [projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return (
    <>
      <SettingsGroup
        title={scope ? `${scope.projectName}'s servers` : "Machine-wide servers"}
        description={
          scope
            ? "Tool servers only this project's sessions see. A server here with the same id as a machine-wide one replaces it — which is how a project points a familiar tool name at its own workspace."
            : "Tool servers every project sees. A project can define one with the same id to replace it for itself."
        }
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
          servers.map((server) => <ServerRow key={server.id} server={server} scope={scope} onChange={() => void load()} />)
        )}
      </SettingsGroup>

      <AddServerForm scope={scope} onAdded={() => void load()} />

      {/* The other half of what this project's sessions get, shown here rather
          than left implicit: a tool arriving in a transcript that this page did
          not list is the confusion the scope split could otherwise create. */}
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
        {/*
          STILL MISSING, AND SAID OUT LOUD RATHER THAN LEFT TO BE DISCOVERED.
          The legacy cockpit could sign in to an HTTPS MCP server on the user's
          behalf — OAuth 2.1 discovery, PKCE, a token store and refresh, all in
          packages/core/src/mcp-oauth.ts — and could store a header value as a
          secret reference instead of a literal. Neither exists in this engine
          yet, so a server that needs a bearer token needs one typed as a plain
          header, and `McpServerSpec.headers` is returned verbatim on read.
        */}
        <Row
          label="Signing in to an HTTPS server"
          hint="Not built here yet. A server that needs OAuth cannot be connected from this page, and a header typed here is stored as written."
          control={<Badge variant="outline">Missing</Badge>}
        />
      </SettingsGroup>
    </>
  );
}
