/**
 * THE PLUGIN HOST'S EXECUTABLE HALF. Schemas, factories, lifecycle hooks —
 * everything that is code rather than data, and therefore everything that
 * CANNOT cross a wire. The serializable half is
 * `@telar/engine-client`'s `protocol/plugins.ts`, and the split is load-bearing:
 * the day plugins are installed from a folder, the manifest on disk is
 * `PluginMeta` unchanged and only the module-loading half is new.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * NOT A SANDBOX. A bundled plugin's engine module is ordinary in-process code
 * imported by the daemon; it can read any file the daemon can and spawn any
 * process the daemon can. The host bounds MISTAKES (a hung `init`, a plugin
 * that throws on startup, a plugin that leaks a subprocess) and it bounds
 * AUTHORITY CLAIMS (see `policy.ts`). It does not bound malice, and no comment
 * in this tree should suggest it does. External plugins will need a different
 * story than "we call the function"; that story is not written yet, and shipping
 * bundled plugins does not write it.
 */
import type { PluginMeta } from "@telar/engine-client";
import type { z } from "zod";
import type { PluginWorkLog } from "./work-log";

/**
 * WHY EVERY LIFECYCLE HOOK IS BOUNDED. A plugin's `init` runs inside daemon
 * startup: an unbounded one is a daemon that never listens, and "Telar didn't
 * start" is a far worse failure than "LaTeX is unavailable". The host enforces
 * this deadline rather than trusting the hook — the plugin cannot opt out.
 */
export const PLUGIN_INIT_TIMEOUT_MS = 10_000;

/** Same argument for teardown, but shorter: shutdown must not hang on a plugin. */
export const PLUGIN_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * What `init` is handed. The `onDispose` register is the important member and
 * the reason this is a context rather than a bare call.
 *
 * PARTIAL INITIALISATION IS THE NORMAL FAILURE, not an exotic one: a plugin
 * that opens a socket, starts a sweeper and then throws while probing a
 * toolchain has acquired two things it must give back. So a hook registers each
 * resource AS IT ACQUIRES IT, and the host unwinds whatever was registered when
 * the rest fails — the same discipline a `defer` gives you, applied to startup.
 */
export type PluginInitContext = {
  /** The daemon's own identity, for work breadcrumbs that outlive a process. */
  daemonId: string;
  /** Where the plugin may keep machine-scoped durable state. */
  stateDir: string;
  /**
   * The breadcrumb log for work that outlives nothing. HANDED IN HERE rather
   * than taken as a factory dependency because the host owns it and the host is
   * constructed FROM the modules — a plugin that demanded it up front could not
   * be built without building the log twice.
   */
  work: PluginWorkLog;
  /**
   * Register a cleanup for something just acquired. Run in REVERSE order, both
   * on normal dispose and when a later step of `init` fails.
   */
  onDispose(name: string, cleanup: () => void | Promise<void>): void;
};

/**
 * Why a plugin is being torn down. Carried into `dispose` because "the daemon
 * is shutting down" and "this project turned you off" want different behaviour:
 * the first may abandon work, the second must not.
 */
export type PluginDisposeReason = "shutdown" | "disabled" | "init_failed" | "replaced";

/**
 * DISABLE MEANS DRAIN, and the three verbs are deliberately separate.
 *
 *   drain    stop accepting NEW work; let what is running finish; then release
 *            whatever has gone idle. This is what flipping the switch does.
 *   cancel   stop work that is running. A SEPARATE, EXPLICIT USER ACTION —
 *            never a side effect of a settings toggle.
 *   dispose  give back everything, running or not. Shutdown, or after a drain.
 *
 * Collapsing drain into cancel is the mistake this shape exists to prevent: a
 * person who unticks "Data science" while a 20-minute training cell is running
 * has not asked to kill it, and a host that kills it has silently redefined a
 * settings toggle as a stop button.
 */
export type PluginScopeHooks = {
  /**
   * Called when a project turns the plugin off, and before `dispose` on
   * shutdown. Must return once new work is refused — NOT once running work has
   * finished. The host polls `busy` for that.
   */
  drain?(projectId: string, reason: PluginDisposeReason): void | Promise<void>;
  /**
   * Whether this plugin still has work running for a project. Read by the host
   * after a drain to decide whether idle resources may be released yet. A
   * plugin with no long-running work simply omits it.
   */
  busy?(projectId: string): boolean;
  /**
   * Release everything idle for a project. Called after `drain` once `busy`
   * reports false — or immediately, for a plugin that declares no `busy`.
   */
  releaseProject?(projectId: string): void | Promise<void>;
  /**
   * A session went away (archived, deleted). Replaces the hardcoded
   * `releaseDataScience` call the store used to make by name.
   */
  releaseSession?(sessionId: string, reason: string): void | Promise<void>;
};

/**
 * The engine-side module. Bundled today, imported statically; the shape is the
 * one an external loader would have to produce.
 */
export type PluginEngineModule<Settings = unknown> = {
  meta: PluginMeta;
  /**
   * Validates the opaque `settings` blob the protocol carries. THE PLUGIN OWNS
   * ITS OWN SETTINGS SHAPE — that is the whole reason the blob is opaque in
   * `protocol/plugins.ts` — and the host refuses a write that fails this rather
   * than storing something the plugin will choke on later.
   */
  settingsSchema?: z.ZodType<Settings>;
  /**
   * Acquire whatever the plugin needs, bounded by `PLUGIN_INIT_TIMEOUT_MS`, and
   * register a cleanup for each acquisition. Omit it entirely when there is
   * nothing to acquire — most plugins have nothing.
   */
  init?(context: PluginInitContext): void | Promise<void>;
  hooks?: PluginScopeHooks;
  /**
   * THE TOOL WALL IS NOT HERE — see `tool-module.ts`. It is registered in the
   * WORKER, a different process from the one this module lives in, so it can
   * only be written against the plugin's capability port rather than against
   * this module's runtime.
   */
  /**
   * The HTTP verbs the cockpit calls directly, as a table rather than as another
   * arm in the daemon's router.
   *
   * WHY A TABLE AND NOT A HANDLER. The daemon's existing `/ds/<method>` and
   * `/latex/<method>` arms are ~20-line switch statements that reach for
   * `HttpError`, `body()`, `stringValue()` and the session resolution around
   * them. A plugin that took a `(request, response)` would inherit all of that,
   * and every plugin would then own a piece of the daemon's error contract. A
   * table cannot: the host resolves the session, the daemon parses the body and
   * writes the response, and the plugin sees an already-parsed object and
   * returns a value. A thrown error becomes `plugin_error` with the plugin's id
   * on it, so a broken plugin is legible as ITS failure rather than the
   * daemon's.
   *
   * `capability` is whatever the plugin's own capability port resolves to for
   * this session — the same object its toolkit gets, so the HTTP door and the
   * agent door cannot drift apart.
   */
  routes?: Record<string, (input: Record<string, unknown>, capability: unknown) => unknown | Promise<unknown>>;
  /**
   * Resolve this plugin's capability for a session, or throw if the project has
   * not opted in. The host never invents this — a plugin that has no HTTP door
   * and no tools simply omits it.
   */
  resolve?(sessionId: string): unknown;
};

/** A registered plugin plus whatever its lifecycle has done to it since. */
export type PluginRecord = {
  module: PluginEngineModule;
  state: "ready" | "failed" | "disposed";
  error?: string;
  initMs?: number;
  /** Cleanups registered during `init`, newest first. */
  cleanups: { name: string; run: () => void | Promise<void> }[];
};

export type { PluginMeta };
