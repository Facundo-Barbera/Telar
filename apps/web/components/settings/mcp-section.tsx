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
 * full editor behind Configure, and the donor's Connect button now beside it.
 *
 * SIGNING IN IS THE ONE CREDENTIAL TELAR MINTS. Everywhere else the rule is
 * that Telar adopts logins and never creates them, because `claude` and `codex`
 * each have their own sign-in and their own store. A third-party MCP server has
 * neither: nothing else on this machine will hold that grant, so declining to
 * run the flow means the server does not work at all. The token never reaches
 * this component — `mcpOAuthStatus` answers booleans, an expiry and an issuer.
 */

import { useCallback, useEffect, useState } from "react";
import { GlobeIcon, PlugIcon, Settings2Icon, TerminalIcon, XIcon } from "lucide-react";
import type { McpOAuthStatus, McpServer, McpServerSpec } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";
import { HEALTH_DOT, signInAction, signInSummary, statusFor } from "@/lib/mcp-oauth";

const api = createEngineApi();

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
  /** A sign-in for this row is happening in another window. */
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
  /**
   * THE CONSENT SCREEN OPENS WHEREVER THE SHELL SENDS IT, and in the desktop
   * app that is NOT this window.
   *
   * Measured, by pressing the button: `apps/desktop/browser-manager.js`'s
   * `createExternalLinkPolicy` routes every off-origin navigation to the
   * system browser and refuses it in-app. So the authorization server, the
   * consent screen and the callback all happen in Safari; this window does not
   * move, and the redirect's `?mcpConnected=` — which the browser tab version
   * of this flow relies on — lands somewhere nobody is looking. The grant was
   * stored correctly and the pane sat there showing "Sign in".
   *
   * That is the RIGHT behaviour to keep, not to work around: a consent screen
   * belongs in a browser with a real address bar, where the person can see
   * whose login page they are typing into. It is what every desktop app with
   * OAuth does. What has to change is this side — the pane cannot assume it
   * will be the one the callback returns to, so it watches for the grant
   * instead (`onAwait` below).
   */
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
            {/* Said out loud, because in the desktop app the consent screen is
                in a DIFFERENT WINDOW and this one looks like nothing happened. */}
            {awaiting ? (
              <span className="text-[11px] text-muted-foreground">Finish signing in, in your browser…</span>
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
        <div className="space-y-2 bg-muted/20 px-4 py-2">
          {status && (status.connected || status.requiresOAuth) && (
            <p className="text-[11px] leading-snug text-muted-foreground">
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
            <p className="text-[11px] text-muted-foreground">
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
                  if (!window.confirm(`Remove "${server.label}"? Sessions stop being offered its tools.`)) return;
                  void act(() => api.removeMcpServer(server.id, scope?.projectId));
                }}
              >
                <XIcon />
                Remove
              </Button>
            </div>
          </div>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
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
  const [statuses, setStatuses] = useState<McpOAuthStatus[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [outcome, setOutcome] = useState<{ connected?: string; error?: string }>();
  /** The server whose sign-in is happening in another window right now. */
  const [awaiting, setAwaiting] = useState<string>();

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

  /**
   * SIGN-IN STATE IS A SECOND, SEPARATE FETCH, and it is allowed to be slow or
   * to fail on its own. It costs two network round trips PER SERVER — a
   * detection probe and an authenticated `initialize` — against third parties
   * this cockpit does not control. Folded into `load`, one unreachable server
   * would hold the whole pane blank; kept apart, the list paints immediately
   * and the dots arrive when they arrive.
   */
  const loadStatuses = useCallback(async () => {
    try {
      const { statuses: next } = await api.mcpOAuthStatus(projectId);
      setStatuses(next);
      // Stop watching the moment the grant appears. Done HERE, where the answer
      // arrives, rather than in an effect reacting to it: that would be derived
      // state pretending to be synchronization, and it cascades a render.
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

  /**
   * WATCHING FOR A SIGN-IN THAT IS HAPPENING SOMEWHERE ELSE.
   *
   * In the desktop app the consent screen opens in the system browser (see
   * `signIn` above for the measurement), so the callback's redirect never
   * reaches this window and there is no message to listen for — the browser and
   * the app share nothing but the engine. What they DO share is the engine, and
   * the grant lands there. So this asks the engine.
   *
   * FOCUS IS THE REAL SIGNAL and the interval is the backstop. Coming back to
   * the app is exactly the moment a person expects it to have noticed, and it
   * costs one request. The 2-second poll covers the case where both windows are
   * visible at once — on a second monitor, or in a plain browser tab — and it
   * STOPS AFTER TWO MINUTES rather than polling a third-party server forever
   * because somebody wandered off mid-consent.
   */
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

  /**
   * WHAT THE CALLBACK CAME BACK WITH, when it came back HERE.
   *
   * Only the plain-browser path lands here; the desktop path is handled by the
   * watcher above. Both are kept because both happen — this cockpit is opened
   * in a browser as often as in the shell.
   *
   * The redirect from `/api/mcp/oauth/callback` carries the result in the query
   * because it is the only channel that survives a round trip through a third
   * party's consent screen. Read once and STRIPPED from the URL immediately —
   * left in place, a refresh or a shared link would replay a sign-in
   * announcement for something that did not just happen.
   *
   * DEFERRED THROUGH A TIMEOUT, like the loads above. Setting state
   * synchronously in an effect body cascades a second render before the first
   * has painted, and the address bar is an external system this is reading
   * from and writing back to — which is the case the rule exists to catch.
   */
  useEffect(() => {
    const task = window.setTimeout(() => {
      const query = new URLSearchParams(window.location.search);
      const connected = query.get("mcpConnected");
      const error = query.get("mcpOAuthError");
      if (!connected && !error) return;
      setOutcome({ ...(connected ? { connected } : {}), ...(error ? { error } : {}) });
      query.delete("mcpConnected");
      query.delete("mcpOAuthError");
      // `section` DELIBERATELY SURVIVES. It is not an announcement, it is
      // where you are: stripping it made a refresh of this page bounce back to
      // Appearance, which is the same disorientation the redirect was fixed to
      // avoid. The announcement is spent; the location is not.
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

      {/*
        THE SECTION THAT USED TO BE HERE WAS A COMMENT WEARING A SECTION'S
        CLOTHES. "Which sessions see these" listed Claude and Codex, both
        reading "Applied" — a row that can only ever say one thing is not
        state, it is prose — beside a warning about typing a header, which this
        form has no field for. Three rows of chrome, nothing to act on.

        The two facts in it are still true and still worth writing down, so
        they live where they bite instead:
          · Both providers get this list — apps/engine/src/driver.ts for the
            Agent SDK translation, apps/engine/src/codex-driver.ts for the
            thread/start overlay.
          · `spec.headers` is stored as written and returned verbatim on read,
            so a bearer token set through the API round-trips to any browser
            that opens this pane. A managed sign-in does not: its token lives
            in the engine's own 0600 store. The fix is the redaction the
            provider registry already has, not yet built for MCP servers.
      */}
    </>
  );
}
