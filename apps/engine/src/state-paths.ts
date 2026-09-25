/**
 * EVERY FILE AND DIRECTORY AT THE STORE ROOT, IN ONE LIST — issue #665.
 *
 * ══ WHY THIS IS ITS OWN MODULE ══
 *
 * It lived in `state.ts`, and that made the rule it exists to state
 * unenforceable. `state.ts` imports `ExecutionStore` and `worktrees-location`,
 * so those two could not import it back without a cycle — and both of them own
 * a file at the store root. The result was exactly the shape #665 found: two
 * ways to name a root file, one of them a list and one of them a scattering of
 * `path.join(root, "…")`, with no way to tell which names were sanctioned.
 *
 * A module that imports nothing but `node:path` can be imported by ALL of them,
 * which is what makes "`statePaths` is the only way to name a store-root file"
 * a property rather than an aspiration — and it is the precondition for
 * `store-shape.test.ts`, whose allowlist IS this list. A file composed by hand
 * is a file the store shape does not know about, and the invariant test now
 * fails on one.
 *
 * `state.ts` re-exports both of these, so every existing import keeps working
 * and nothing had to be renamed to get the cycle out.
 *
 * ══ ADDING ONE ══
 *
 * A new root-level file goes in `EngineStatePaths` and in `statePaths()`, with
 * a comment saying WHY it is at the root rather than in the execution database,
 * in the same change that first writes it.
 */
import path from "node:path";

export type EngineStatePaths = {
  root: string;
  projects: string;
  /** Plugin facts true of this Mac. See `machinePlugins()`. */
  machinePlugins: string;
  /** The Claude default this machine last read from the provider — what a
   *  synchronous claim uses when the in-memory catalogue is cold. */
  claudeDefault: string;
  sessions: string;
  /** User-configured MCP servers. ENVIRONMENT-SCOPED, beside projects.json
   *  rather than inside a session: a tool is configured once. */
  mcpServers: string;
  /** Configured provider instances — the account registry. */
  providerInstances: string;
  /**
   * Their sensitive environment values, in a file of their own at 0600.
   *
   * SPLIT SO THE REGISTRY CAN BE READ FREELY. `listProviderInstances` hands its
   * answer to a settings page over HTTP; if a secret lived on the record, every
   * open of that page would echo back every API key the user had ever typed.
   * Keeping them apart makes redaction the default rather than a step somebody
   * has to remember at each call site.
   */
  providerSecrets: string;
  /**
   * What each login's reader did to that provider's model list — starred,
   * hidden, ordered, plus the ids they typed because the installed CLI does not
   * publish them yet.
   *
   * ITS OWN FILE, NOT A FIELD ON THE INSTANCE, for a sharper version of the
   * reason the secrets are split out: `provider-instances.json` is read on every
   * session claim through `resolveProviderInstance`, and dragging a model up one
   * place in a menu must not rewrite the routing registry.
   */
  modelOverlays: string;
  /** The last good catalogue per provider — see `EngineStore.modelCatalogue`. */
  modelCatalogues: string;
  /**
   * Completed MCP OAuth grants — access token, refresh token, the resolved
   * authorization server and the client they were minted for.
   *
   * ITS OWN FILE, AT 0600, FOR THE SAME REASON `providerSecrets` IS: the server
   * registry beside it is read by a settings page over HTTP, and a token stored
   * on the record would be echoed back to every browser that opened it. Here
   * only the claim reads this, and no route returns it.
   */
  mcpOAuth: string;
  /**
   * Sign-ins currently in flight, keyed by the OAuth `state`.
   *
   * ON DISK RATHER THAN IN MEMORY because a flow spans a browser round trip
   * through a third party, and an engine that restarted in that window would
   * otherwise strand it with an error the user cannot act on. Entries expire;
   * each holds a PKCE verifier, which is a secret for the length of one flow.
   */
  mcpOAuthPending: string;
  /**
   * How the reader wants their session list banded — see `InboxPolicy`.
   *
   * ENVIRONMENT-SCOPED, beside projects.json, for the same reason mcp-servers is:
   * it is configured once and read by every client. A per-browser copy would put
   * the same session in two different bands depending on which window you opened.
   */
  inbox: string;
  /**
   * How long the raw turn journal is kept — see `RetentionPolicy`.
   *
   * BESIDE `inbox.json` RATHER THAN INSIDE IT, though both are standing rules
   * about sessions. `inbox.json` decides what a list SHOWS; this one decides
   * what the store KEEPS, and folding a delete into the document that bands a
   * sidebar is how somebody changes a window and loses history.
   */
  retention: string;
  /**
   * Whether Telar may tell an agent where it is — see `AgentOrientation`.
   *
   * ENVIRONMENT-SCOPED, beside inbox.json and for the sharper version of its
   * reason: this decides what every session on the machine is told, so a
   * per-browser copy would mean one engine injecting a paragraph some of its
   * own clients had switched off.
   */
  orientation: string;
  /**
   * The CLIProxyAPI hubs quota is read from — see `listUsageLimitSources`.
   *
   * ENVIRONMENT-SCOPED, beside mcp-servers.json and for the same reason: a hub
   * is configured once and every client reads the same list.
   */
  usageLimitSources: string;
  /**
   * Their management keys, in a file of their own at 0600.
   *
   * SPLIT FOR EXACTLY THE REASON `providerSecrets` IS: the list beside it is
   * handed to a settings page over HTTP, and a key stored on the record would
   * be echoed back to every browser that opened Providers. Keeping them apart
   * makes redaction the default rather than a step somebody has to remember.
   */
  usageLimitSecrets: string;
  /** Which sessions want to be woken by which — engine-wide, because a
   *  subscription spans two sessions and belongs to neither's directory. */
  subscriptions: string;
  /** Who writes generated titles and branch names — see `TextGenPolicy`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  textGen: string;
  /** What a session is created with when nobody said — see `SessionDefaults`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  sessionDefaults: string;
  /** How a project's worktrees are prepared — this Mac's defaults and every
   *  project's overrides, in one document. See `workspace-config.ts`.
   *  Environment-scoped like `sessionDefaults`: read when a worktree is cut. */
  workspace: string;
  /** The automatic cleanup's switches and last result — see `cleanup.ts`.
   *  Environment-scoped: one policy for every project on this engine. */
  cleanup: string;
  /** Where each project group sits in the rail — see `SidebarLayout`.
   *  Environment-scoped like `inbox`: one arrangement per engine, not per window. */
  sidebarLayout: string;
  /**
   * The host cockpit's resolved look, republished for paired clients — see
   * `getAppearance`. Environment-scoped like `textGen`, but for the opposite
   * reason: appearance genuinely LIVES in one browser's localStorage, and this
   * file is the only place another device can read it from.
   */
  appearance: string;
  engine: string;
  lock: string;
  /**
   * The sqlite journal's own marker — see `ExecutionStore`'s constructor.
   *
   * `ExecutionStore` WRITES THIS ONE AND READS IT FROM HERE. It takes a bare
   * `root` rather than an `EngineStatePaths`, so it calls `statePaths(root)`
   * for the one field it needs; that is possible only because this module
   * imports nothing but `node:path`, which is the whole argument in its header.
   */
  executionStore: string;
  /**
   * Background-task kills queued for a worker that was not there to take them
   * — see `readTaskStopDeliveries`.
   *
   * ITS OWN DOCUMENT, NOT A QUEUE FIELD, because a delivery outlives the turn
   * that requested the stop: `cancel` may run against a worker that already
   * disappeared, and the kill has to wait somewhere for whichever worker picks
   * the session back up.
   */
  taskStops: string;
  /** Where session checkouts are cut, when it is not the default beside the
   *  store — see `worktrees-location.ts`. */
  worktreesLocation: string;
  /** The per-transcript usage parse, cached beside the rates it is priced
   *  with — see `usage.ts`. Derived and disposable, unlike the two usage
   *  documents above that a person configured by hand. */
  usageScanCache: string;
  /** The provider rates `usageScanCache` is priced with, refreshed
   *  stale-while-revalidate rather than on a timer — see `daemon.ts`'s
   *  `/v2/usage` handler. */
  usageModelRates: string;
  /** What #523 designated as the Main session, until #531 dropped the
   *  designation. Litter with no reader; the sweep that removed it went with
   *  the built-in Agent (#908), and it stays named here so a leftover copy is
   *  not flagged as an undeclared file. */
  mainSession: string;
  /** The marker `sweepSpoolAndLooms` leaves once it has removed the Spool's
   *  and the Looms' leftovers, so a swept home does not walk both trees again
   *  on every later start — see `decommission-sweep.ts`. */
  decommissionMarker: string;
  /**
   * WHERE A DECOMMISSIONED FEATURE'S DATA IS SET ASIDE, not deleted — #908.
   * `retired/agent-<stamp>/` is the built-in Agent's whole `agent/` directory,
   * moved there once by `retireAgentStore`.
   */
  retired: string;
  /** The marker `retireAgentStore` leaves once it has run, so a home is
   *  handled once — see `decommission-sweep.ts`. */
  agentRetiredMarker: string;
  /**
   * Chromium user-data-dirs for the HEADLESS browser runtime — `BrowserRuntime`
   * in `daemon.ts`, the provider a detached machine or a quit app falls back
   * to.
   *
   * NOT THE ONLY `browser-profiles` IN THIS APP, and the other one matters:
   * `<userData>/Partitions/<name>` holds the Electron partitions for the
   * INTEGRATED browser a human actually clicks. That one lives outside the
   * store, beside the shell's own config, and moves with nothing — a window a
   * person is looking at is not state the storage picker relocates. This one
   * is inside the store and moves with it, because a headless profile is a
   * login the human helped with on Tuesday and nothing a person would notice
   * following the store to a new drive.
   */
  browserProfiles: string;
  /**
   * Per-worker connectivity evidence, JSONL, rotated — see
   * `worker-diagnostics.ts`.
   *
   * NOT THE ONLY `diagnostics` IN THIS APP, and the other one is the reason
   * this comment exists: the desktop shell keeps its own `diagnostics/` in
   * Electron's `userData`, heap snapshots taken outside the store entirely.
   * Same name, same shape of reason — engine state moves with the store,
   * shell state does not — different level, different directory.
   */
  diagnostics: string;
  /**
   * WHEN THE `node_modules` REAP LAST RAN — issue #633.
   *
   * A TIME, NOT A "DONE" FLAG, and that is the difference from
   * `decommissioned-spool-looms` beside it. That marker records that a home has
   * been swept forever, which is right for litter with no reader: the Spool is
   * gone and will not come back. Archived sessions keep arriving, so a
   * once-ever marker would take today's backlog and then never run again.
   */
  nodeModulesReaped: string;
};

export function statePaths(root: string): EngineStatePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    projects: path.join(resolved, "projects.json"),
    /** Plugin facts true of THIS Mac — see `MachinePlugins`. */
    machinePlugins: path.join(resolved, "machine-plugins.json"),
    claudeDefault: path.join(resolved, "claude-default-model.json"),
    sessions: path.join(resolved, "sessions"),
    mcpServers: path.join(resolved, "mcp-servers.json"),
    providerInstances: path.join(resolved, "provider-instances.json"),
    providerSecrets: path.join(resolved, "provider-secrets.json"),
    modelOverlays: path.join(resolved, "model-overlays.json"),
    modelCatalogues: path.join(resolved, "model-catalogues.json"),
    mcpOAuth: path.join(resolved, "mcp-oauth.json"),
    mcpOAuthPending: path.join(resolved, "mcp-oauth-pending.json"),
    inbox: path.join(resolved, "inbox.json"),
    /** How long the raw turn journal is kept — see `RetentionPolicy`. Default
     *  never, so this document does not exist on a store nobody configured. */
    retention: path.join(resolved, "retention.json"),
    orientation: path.join(resolved, "orientation.json"),
    usageLimitSources: path.join(resolved, "usage-limit-sources.json"),
    usageLimitSecrets: path.join(resolved, "usage-limit-secrets.json"),
    subscriptions: path.join(resolved, "subscriptions.json"),
    textGen: path.join(resolved, "text-generation.json"),
    sessionDefaults: path.join(resolved, "session-defaults.json"),
    workspace: path.join(resolved, "workspace.json"),
    cleanup: path.join(resolved, "cleanup.json"),
    sidebarLayout: path.join(resolved, "sidebar-layout.json"),
    appearance: path.join(resolved, "appearance.json"),
    engine: path.join(resolved, "engine.json"),
    lock: path.join(resolved, "engine.lock"),
    executionStore: path.join(resolved, "execution-store.json"),
    taskStops: path.join(resolved, "task-stops.json"),
    worktreesLocation: path.join(resolved, "worktrees-location.json"),
    usageScanCache: path.join(resolved, "usage-scan-cache.json"),
    usageModelRates: path.join(resolved, "usage-model-rates.json"),
    mainSession: path.join(resolved, "main-session.json"),
    decommissionMarker: path.join(resolved, "decommissioned-spool-looms"),
    retired: path.join(resolved, "retired"),
    agentRetiredMarker: path.join(resolved, "decommissioned-agent"),
    browserProfiles: path.join(resolved, "browser-profiles"),
    diagnostics: path.join(resolved, "diagnostics"),
    nodeModulesReaped: path.join(resolved, "node-modules-reaped"),
  };
}
