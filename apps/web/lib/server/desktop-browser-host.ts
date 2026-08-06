import type { BrowserToolResult } from "@/lib/server/browser-runtime";
import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";

export type DesktopBrowserCommand = {
  id: string;
  scopeKey: string;
  name: string;
  args: Record<string, unknown>;
};

type CommandListener = (command: DesktopBrowserCommand) => void;

type PendingResponse = {
  /** Only the host a command was dispatched to may answer or fail it. */
  hostId: string;
  resolve: (result: BrowserToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Set only while the command sits in a host's queue, undelivered. */
  queuedTimer?: ReturnType<typeof setTimeout>;
};

type DesktopHost = {
  id: string;
  lastSeen: number;
  /** Recency for routing. Separate from `lastSeen` because two renderers can
   * register inside one millisecond and the tie has to break deterministically. */
  usedAt: number;
  listeners: Set<CommandListener>;
  /** Scopes this host has claimed — the conversations whose tabs live in its
   * window. Claimed on the first command as well as on publish, in claim order
   * so the cap sheds the conversation this window touched longest ago. */
  scopes: Set<string>;
  /** Commands accepted between register and the host's command stream opening. */
  queue: DesktopBrowserCommand[];
};

const HOST_STALE_MS = 35_000;
const COMMAND_TIMEOUT_MS = 30_000;
// A command no stream ever accepted is not slow, it is undeliverable: the host
// registered but never opened (or lost) its command channel. Fail it well short
// of COMMAND_TIMEOUT_MS so the caller gets an actionable message instead of the
// wedged-browser timeout this module exists to remove. Long enough to cover the
// register -> stream-open gap and an EventSource reconnect, which the browser
// retries within a few seconds.
const QUEUED_COMMAND_GRACE_MS = 10_000;
// Cached scope states now outlive the host that published them, so the map
// needs a ceiling: a long-lived server would otherwise retain one entry per
// conversation ever opened. Re-inserting on publish keeps it in recency order.
const MAX_CACHED_SCOPES = 32;
// The renderer registers under a placeholder scope before any conversation has
// a browser (components/desktop-browser-host.tsx). It is not a conversation:
// caching it would burn a cache slot and claim a scope no agent can call.
const HOST_PLACEHOLDER_SCOPE = "__host__";

/**
 * Routes agent browser commands to the desktop renderer that owns a session scope.
 *
 * Hosts are renderers, not conversations: one `DesktopBrowserHost` bridge per
 * window, each fronting an Electron browser manager that can serve any scope.
 * So several hosts coexist (a second window, a reload mid-teardown) and scope
 * ownership is a routing *preference* — the host already holding a scope's tabs
 * wins, and a scope nobody holds goes to the freshest live host, which opens
 * the view on demand. Before this was a map, the last renderer to register was
 * the only one that could ever receive a command, and every other surface's
 * agent calls sat in a shared queue until they timed out.
 *
 * Scope: a packaged desktop build injects TELAR_DESKTOP_BROWSER_CONTROL_PORT
 * into the Next server it spawns, so browser-runtime.ts talks to Electron's
 * HTTP control server directly and never reaches this broker. This path carries
 * development, where the dev server is external and has no such env.
 */
export class DesktopBrowserHostBroker {
  private readonly instanceId = crypto.randomUUID();
  private hosts = new Map<string, DesktopHost>();
  private states = new Map<string, ControlledBrowserState>();
  private responses = new Map<string, PendingResponse>();
  private listeners = new Set<() => void>();
  private clock = 0;

  identity() {
    return this.instanceId;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private markSeen(host: DesktopHost) {
    host.lastSeen = Date.now();
    host.usedAt = ++this.clock;
  }

  /** Drops hosts that stopped heartbeating, failing their in-flight work now
   * rather than letting it ride out the command timeout. */
  private sweep() {
    const cutoff = Date.now() - HOST_STALE_MS;
    for (const [hostId, host] of this.hosts) {
      if (host.lastSeen <= cutoff) this.disconnect(hostId);
    }
  }

  /** Binds a scope to the host serving it. Capped, because a renderer that
   * outlives hundreds of conversations would otherwise hold one entry each —
   * the growth MAX_CACHED_SCOPES exists to prevent. Affinity is a preference,
   * so shedding the coldest claim costs an on-demand reopen, not correctness. */
  private claim(host: DesktopHost, scope: string) {
    if (scope === HOST_PLACEHOLDER_SCOPE) return;
    host.scopes.delete(scope);
    host.scopes.add(scope);
    for (const stale of host.scopes) {
      if (host.scopes.size <= MAX_CACHED_SCOPES) break;
      host.scopes.delete(stale);
    }
  }

  /** Insertion order is publish recency, so the front of the map is coldest.
   * A scope a live host still holds is never dropped: evicting it blanks a
   * surface that keeps reporting itself online, which is the symptom in the
   * issue title. Those shed their screenshot instead — the only large field,
   * and the host republishes it with its next state push. */
  private evictOverflow() {
    if (this.states.size <= MAX_CACHED_SCOPES) return;
    const held = new Set<string>();
    for (const host of this.hosts.values()) {
      for (const scope of host.scopes) held.add(scope);
    }
    let overflow = this.states.size - MAX_CACHED_SCOPES;
    for (const [scopeKey, state] of this.states) {
      if (overflow <= 0) break;
      overflow -= 1;
      if (!held.has(scopeKey)) {
        this.states.delete(scopeKey);
        continue;
      }
      if (state.screenshot) this.states.set(scopeKey, { ...state, screenshot: null });
    }
  }

  private publish(host: DesktopHost, state: ControlledBrowserState) {
    const scope = state.scopeKey?.trim();
    if (!scope || scope === HOST_PLACEHOLDER_SCOPE) return;
    this.claim(host, scope);
    this.states.delete(scope);
    this.states.set(scope, { ...state, provider: "desktop", running: true, available: true });
    this.evictOverflow();
  }

  register(hostId: string, state: ControlledBrowserState) {
    const host = this.hosts.get(hostId) ?? {
      id: hostId,
      lastSeen: 0,
      usedAt: 0,
      listeners: new Set<CommandListener>(),
      scopes: new Set<string>(),
      queue: [],
    };
    this.markSeen(host);
    this.hosts.set(hostId, host);
    this.publish(host, state);
    this.sweep();
    this.emit();
  }

  touch(hostId: string) {
    const host = this.hosts.get(hostId);
    if (host) this.markSeen(host);
  }

  /** Retires a pending command's bookkeeping. Both timers, always: the queued
   * grace outlives the response entry otherwise and rejects a settled promise. */
  private settle(id: string, pending: PendingResponse) {
    this.responses.delete(id);
    clearTimeout(pending.timer);
    if (pending.queuedTimer) clearTimeout(pending.queuedTimer);
  }

  disconnect(hostId: string) {
    const host = this.hosts.get(hostId);
    if (!host) return;
    this.hosts.delete(hostId);
    host.listeners.clear();
    host.queue = [];
    // Cached scope states survive a host *swap*: the Electron tabs did not close
    // because one renderer reloaded, and wiping them blanked every other
    // conversation's surface. Losing the last host is the other case — the
    // Electron side is gone and its tabs went with it, so keeping the cache
    // would serve a dead process's tab list, with `running: true`, forever.
    if (this.hosts.size === 0) this.states.clear();
    for (const [id, pending] of [...this.responses]) {
      if (pending.hostId !== hostId) continue;
      this.settle(id, pending);
      pending.reject(new Error("The Telar desktop browser host disconnected."));
    }
    this.emit();
  }

  online() {
    this.sweep();
    return this.hosts.size > 0;
  }

  state(scopeKey: string): ControlledBrowserState | null {
    // Null hands the caller back to the Playwright fallback, so it must mean
    // "no desktop at all" — never merely "no desktop state for this scope".
    if (!this.online()) return null;
    const published = this.states.get(scopeKey);
    if (published) return published;
    // A scope no host has published is UNKNOWN, not empty: a live host will
    // serve it on demand, but nothing is open for it yet. `running: false` is
    // how that reads within ControlledBrowserState — published states above are
    // always `running: true`. It stays byte-identical to the client's
    // EMPTY_STATE (lib/use-controlled-browser.ts) on purpose: `available: false`
    // would be a lie while a host stands ready, and filling in `error` — which
    // the contract does carry, and browser-surface.tsx does render — would put
    // an alert banner on every conversation whose browser has simply not been
    // opened. Saying "not opened yet" is a UI affordance, not a server error.
    return {
      scopeKey,
      available: true,
      running: false,
      provider: "desktop",
      tabs: [],
      screenshot: null,
      error: null,
      version: 0,
    };
  }

  updateState(hostId: string, state: ControlledBrowserState) {
    const host = this.hosts.get(hostId);
    if (!host) return;
    this.markSeen(host);
    if (!state.scopeKey) return;
    this.publish(host, state);
    this.emit();
  }

  subscribeCommands(hostId: string, listener: CommandListener) {
    // An unknown host id is a stream that raced or outlived its registration.
    // It gets no commands; the renderer re-registers and opens another stream.
    const host = this.hosts.get(hostId);
    if (!host) return () => {};
    this.markSeen(host);
    host.listeners.add(listener);
    // Only replay work whose caller is still waiting — a queued command whose
    // promise already timed out must not reach Electron and act on a live tab.
    for (const command of host.queue.splice(0)) {
      const pending = this.responses.get(command.id);
      if (!pending) continue;
      if (!this.deliver(host, command)) {
        host.queue.push(command);
        continue;
      }
      // Delivered, so it is no longer waiting on a stream that may never open.
      if (pending.queuedTimer) clearTimeout(pending.queuedTimer);
      pending.queuedTimer = undefined;
    }
    // A closing stream deliberately does NOT re-queue the work it was carrying.
    // The renderer answers over a separate POST, so a command it actually
    // received still resolves across an EventSource reconnect; replaying it
    // would run the click or navigation twice. Work the stream never accepted
    // is caught in `deliver` instead, where the throw proves it was not sent.
    return () => host.listeners.delete(listener);
  }

  private selectHost(scope: string): DesktopHost | null {
    this.sweep();
    const live = [...this.hosts.values()].sort((a, b) => b.usedAt - a.usedAt);
    if (live.length === 0) return null;
    // Ownership outranks attachment. A host whose SSE stream is momentarily
    // closed — an EventSource reconnect, a development reload — still owns its
    // tabs, and its queue drains when the stream returns; handing its scope to
    // another window opens a duplicate view for that conversation, which
    // nothing undoes. Only an unclaimed scope prefers an attached host, since
    // Electron opens it on demand wherever it lands.
    return live.find((host) => host.scopes.has(scope) && host.listeners.size > 0)
      ?? live.find((host) => host.scopes.has(scope))
      ?? live.find((host) => host.listeners.size > 0)
      ?? live[0];
  }

  /** Hands a command to the newest stream a host has open, and reports whether
   * anyone took it. Newest wins because a reconnecting renderer keeps its
   * previous listener registered until the aborted response finishes tearing
   * down, and dispatching into that dead stream was the reported 30s hang. A
   * listener that throws *is* that dead stream (SSE enqueue rejects on a closed
   * controller); the throw proves the command never left the server, so the
   * next stream can have it without risking a repeated click. */
  private deliver(host: DesktopHost, command: DesktopBrowserCommand): boolean {
    for (const listener of [...host.listeners].reverse()) {
      try {
        listener(command);
        return true;
      } catch {
        host.listeners.delete(listener);
      }
    }
    return false;
  }

  private dequeue(host: DesktopHost, id: string) {
    const at = host.queue.findIndex((command) => command.id === id);
    if (at >= 0) host.queue.splice(at, 1);
  }

  call(scopeKey: string, name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
    const scope = String(scopeKey ?? "").trim();
    if (!scope) {
      return Promise.reject(new Error("A browser session scope is required."));
    }
    const host = this.selectHost(scope);
    // Fail now, not in thirty seconds. A timeout reads as a wedged browser and
    // invites a retry; this says what to do about it.
    if (!host) {
      return Promise.reject(new Error(
        "Open Telar Desktop and its Browser surface to share tabs with the agent.",
      ));
    }
    // Claim on dispatch, not on the state push that follows it: `publish` runs
    // only after the renderer's callTool resolves, so until then a second call
    // for the same conversation would pick a different window and open the view
    // twice, splitting it permanently. The first command binds the scope.
    this.claim(host, scope);
    const id = crypto.randomUUID();
    const command: DesktopBrowserCommand = { id, scopeKey: scope, name, args };
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        const pending = this.responses.get(id);
        if (!pending) return;
        this.settle(id, pending);
        // Leaving it queued lets a stream that opens later act on a tab whose
        // caller stopped listening half an hour ago.
        this.dequeue(host, id);
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`The desktop browser timed out while running ${name}.`),
        COMMAND_TIMEOUT_MS,
      );
      const pending: PendingResponse = { hostId: host.id, resolve, reject, timer };
      this.responses.set(id, pending);
      if (this.deliver(host, command)) return;
      host.queue.push(command);
      pending.queuedTimer = setTimeout(
        () => fail(
          "Telar Desktop is not accepting browser commands — its command stream is closed. "
          + "Reopen the Browser surface and retry.",
        ),
        QUEUED_COMMAND_GRACE_MS,
      );
    });
  }

  respond(hostId: string, id: string, result?: BrowserToolResult, error?: string) {
    const host = this.hosts.get(hostId);
    if (!host) return;
    this.markSeen(host);
    const pending = this.responses.get(id);
    if (!pending || pending.hostId !== hostId) return;
    this.settle(id, pending);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result ?? { content: [{ type: "text", text: "Desktop browser action completed." }] });
  }
}

// This broker survives Next.js hot reloads. Bump the key whenever the command
// wire contract or broker interface changes; v1 commands predated session
// scopes, v2 predated the broker-generation handshake used by the SSE host, and
// v3 held a single global host whose fields a multi-host broker cannot read.
// Reusing any of them after a reload leaves methods/protocol/state missing.
const GLOBAL_KEY = Symbol.for("telar.desktop-browser-host.v4");
const brokerProcess = process as NodeJS.Process & { [GLOBAL_KEY]?: DesktopBrowserHostBroker };

export function desktopBrowserHost(): DesktopBrowserHostBroker {
  return brokerProcess[GLOBAL_KEY] ??= new DesktopBrowserHostBroker();
}
