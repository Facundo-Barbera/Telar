/**
 * WHERE THE AGENT LIVES ON DISK — one directory, two files, three verbs (#531).
 *
 * ── WHY THIS IS NOT A METHOD ON `EngineStore` ───────────────────────────────
 * `MainSession` was, and it had to be: it named a SESSION, so every read of it
 * was followed by "does that conversation still exist", which only the store can
 * answer. The Agent names nothing in the store. Its whole state is a thread id
 * and two settings, and folding that into a 578 KB module would put it behind
 * `EngineStore`'s private document IO for no gain. `atomicWrite` is the shared
 * part, and it was already extracted for exactly this case — see `../atomic.ts`.
 *
 * ── THE TWO FILES, AND WHY THE THREAD IS NOT A DOCUMENT ─────────────────────
 *   <engineRoot>/agent/agent.json      — this module
 *   <engineRoot>/agent/threads.sqlite  — LangGraph's checkpoints, `./checkpointer.ts`
 *
 * The conversation is a checkpoint database in the framework's own format, not
 * a Telar document, so it is deliberately NOT written through `atomicWrite`: a
 * saver holds it open and writes to it transactionally, and a rename under an
 * open handle is how a WAL loses its tail. The only thing this module does to
 * that file is MOVE IT ASIDE, and it refuses to do even that until the caller
 * has closed the handle — see `resetAgentThread`.
 *
 * ── ENABLE, DISABLE, RESET — the three, and what each is allowed to destroy ──
 * ENABLE mints a thread id if there is none, and otherwise does nothing to the
 * conversation. DISABLE keeps everything: it is a switch on an entry in the
 * rail, not a delete, and re-enabling has to return to the same conversation —
 * the rule `MainSession.sessionId` already encoded, applied to a thread.
 * RESET is the only verb that retires a conversation, and it ARCHIVES rather
 * than deletes: a person who resets has asked to start again, not to lose what
 * they had. It is also the only verb that moves `generation`.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { AgentSettings as AgentSettingsSchema, DEFAULT_AGENT_SETTINGS, type AgentSettings } from "@telar/engine-client";
import { atomicWrite } from "../atomic";

/** The document's own version stamp, the same field every engine document
 *  carries. Read by nothing yet; present so a later shape change has somewhere
 *  to say which one it is. */
const AGENT_STATE_VERSION = 1;

export type AgentPaths = {
  /** `<engineRoot>/agent` — created on the first write, never on a read. */
  dir: string;
  /** The settings document. */
  settings: string;
  /** The live checkpoint database. */
  threads: string;
};

export function agentPaths(engineRoot: string): AgentPaths {
  const dir = path.join(engineRoot, "agent");
  return { dir, settings: path.join(dir, "agent.json"), threads: path.join(dir, "threads.sqlite") };
}

/**
 * A NEW CONVERSATION'S ID.
 *
 * `thread_` + 32 hex, the shape every other id in this engine has, and opaque
 * on purpose: it is also the `x-opencode-session` header on every model call,
 * so it must carry nothing about the machine it was minted on.
 */
export function mintThreadId(): string {
  return `thread_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The document, or the feature switched off.
 *
 * NEVER THROWS — `getMainSession`'s rule, and here the fallback is the same
 * one: a document somebody hand-edited into nonsense costs the Agent rather
 * than failing every read on the machine. A thread that is still on disk is not
 * lost by this; switching the Agent on again mints a new id, and the old file
 * is still in `agent/` for anyone who goes looking.
 */
export function readAgentSettings(paths: AgentPaths): AgentSettings {
  try {
    const raw = fs.readFileSync(paths.settings, "utf8");
    const parsed = AgentSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_AGENT_SETTINGS };
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

function writeAgentSettings(paths: AgentPaths, next: AgentSettings): AgentSettings {
  atomicWrite(paths.settings, { version: AGENT_STATE_VERSION, ...next });
  return { ...next };
}

/** The suffix an archived thread carries: the instant it was retired, to the
 *  second, in the one format that sorts lexically. */
function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

/**
 * The three files one sqlite database is: the database, and WAL mode's two
 * companions. Moving the first without the others is how a reset would hand the
 * next `open` a database whose committed tail lives in a WAL that no longer
 * belongs to it.
 */
const SQLITE_SIDECARS = ["", "-wal", "-shm"] as const;

/**
 * MOVE THE THREAD ASIDE, AND SAY WHERE IT WENT.
 *
 * Returns the archived path, or `undefined` when there was no database to
 * retire — which is the ordinary case on a machine where the Agent was switched
 * on and never spoken to.
 *
 * THE CALLER MUST HAVE CLOSED THE SAVER. This module cannot check that and does
 * not pretend to; `resetAgentThread` takes a `beforeArchive` hook precisely so
 * the one object that owns the handle is the one that closes it, in the same
 * call that moves the file.
 */
export function archiveThreadFile(paths: AgentPaths, at: number): string | undefined {
  if (!fs.existsSync(paths.threads)) return undefined;
  const base = paths.threads.replace(/\.sqlite$/, "");
  let target = `${base}-${stamp(at)}.sqlite`;
  // Two resets in one second is a person clicking twice, not a collision worth
  // an error: the second gets a counter rather than overwriting the first.
  for (let n = 2; fs.existsSync(target); n += 1) target = `${base}-${stamp(at)}-${n}.sqlite`;
  for (const suffix of SQLITE_SIDECARS) {
    const from = `${paths.threads}${suffix}`;
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, `${target}${suffix}`);
  }
  return target;
}

export type AgentPatch = {
  enabled?: unknown;
  model?: unknown;
  /** `"low" | "medium" | "high"`, or `""` to stop sending the parameter at
   *  all — see `AgentSettings.effort`. */
  effort?: unknown;
  /** `"ask" | "auto"`, or `""` for the default (`ask`). */
  access?: unknown;
  /** Start a new conversation. The only verb that retires a thread, and the
   *  only one that moves `generation`. */
  reset?: unknown;
};

export type AgentPatchOptions = {
  now?: () => number;
  /** Injected by the tests, so a thread id in an assertion is a value the test
   *  chose rather than one it has to read back. */
  mintThreadId?: () => string;
  /**
   * Called once, immediately before the database is moved, and only when there
   * is one to move. The runtime closes its saver here; a test uses it to prove
   * the close happens before the rename rather than after.
   */
  beforeArchive?: () => void;
};

export type AgentPatchResult = {
  settings: AgentSettings;
  /** Where the retired conversation went, when this patch retired one. */
  archived?: string;
};

/**
 * ENABLE, DISABLE, PICK A MODEL, SET EFFORT AND ACCESS, RESET — in that order,
 * and the order is the rule rather than a convenience.
 *
 * RESET IS APPLIED BEFORE `enabled`, so "reset and switch off in one call"
 * archives the conversation and leaves nothing half-done, and "reset and switch
 * on" mints the new thread below rather than reviving the archived id.
 *
 * THE MODEL IS SETTLED FIRST AND MOVES NOTHING. Changing which model the Agent
 * runs is not a new conversation — `MainSession.model`'s own reasoning, and the
 * counter is narrower here than it was there, so this matters more rather than
 * less.
 */
export function patchAgentSettings(paths: AgentPaths, patch: AgentPatch, options: AgentPatchOptions = {}): AgentPatchResult {
  const now = options.now ?? Date.now;
  const mint = options.mintThreadId ?? mintThreadId;
  const stored = readAgentSettings(paths);
  const next: AgentSettings = { ...stored };
  let archived: string | undefined;

  if (patch.model !== undefined) {
    if (typeof patch.model !== "string") throw new Error("the Agent's model must be text");
    const model = patch.model.trim();
    if (model.length > 120) throw new Error("that model id is too long");
    // EMPTY CLEARS IT, back to the default in `./go.ts`. That is what a person
    // emptying the field means, and storing `""` would be a model id nothing
    // serves.
    if (model) next.model = model;
    else delete next.model;
  }

  /**
   * EFFORT AND ACCESS SETTLE WITH THE MODEL, AND MOVE NOTHING.
   *
   * Neither starts a new conversation, for the model's own reason: changing how
   * hard the Agent thinks, or who answers its approvals, is a change to the next
   * TURN and not to the thread. The generation counter stays where it is, and a
   * cockpit's cached transcript stays valid.
   *
   * EMPTY CLEARS, exactly as the model field does: a person clearing the pill
   * means "stop sending it", which for effort is the provider's own default and
   * for access is `ask`. Storing `""` would be a value nothing understands.
   */
  if (patch.effort !== undefined) {
    if (typeof patch.effort !== "string") throw new Error("the Agent's effort must be text");
    const effort = patch.effort.trim();
    if (effort === "") delete next.effort;
    else if (effort === "low" || effort === "medium" || effort === "high") next.effort = effort;
    else throw new Error("the Agent's effort must be low, medium or high");
  }

  if (patch.access !== undefined) {
    if (typeof patch.access !== "string") throw new Error("the Agent's access must be text");
    const access = patch.access.trim();
    if (access === "" || access === "ask") delete next.access;
    else if (access === "auto") next.access = access;
    else throw new Error("the Agent's access must be ask or auto");
  }

  if (patch.reset !== undefined) {
    if (typeof patch.reset !== "boolean") throw new Error("reset must be true or false");
    if (patch.reset) {
      /**
       * THE COUNTER MOVES ONLY WHEN A CONVERSATION WAS ACTUALLY RETIRED.
       * Resetting a machine that has never switched the Agent on has nothing to
       * archive and nothing to invalidate, and bumping there would tell every
       * client its cached transcript was stale about a thread that never
       * existed.
       */
      if (next.threadId !== undefined || fs.existsSync(paths.threads)) {
        options.beforeArchive?.();
        archived = archiveThreadFile(paths, now());
        delete next.threadId;
        next.generation = (stored.generation ?? 0) + 1;
      }
    }
  }

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("the Agent's enabled must be true or false");
    next.enabled = patch.enabled;
  }

  /**
   * THE THREAD IS MINTED BY ENABLING, ONCE.
   *
   * Not by reset, and not by a read: a machine where the Agent is off has no
   * conversation and should not grow one because somebody opened Settings. This
   * is the same "enable, disable, re-enable and a restart can never leave two"
   * rule `setMainSession` states, with a thread where the session was.
   */
  if (next.enabled && next.threadId === undefined) next.threadId = mint();

  return { settings: writeAgentSettings(paths, next), ...(archived ? { archived } : {}) };
}

/**
 * The thread this machine's Agent is on, minting one if it is enabled and has
 * none.
 *
 * FOR THE RUNTIME, which needs an id before it can open a graph and must not
 * have to know whether the settings route has run yet. A disabled Agent answers
 * `undefined` rather than minting: there is nothing to run.
 */
export function ensureThreadId(paths: AgentPaths, options: AgentPatchOptions = {}): string | undefined {
  const stored = readAgentSettings(paths);
  if (!stored.enabled) return stored.threadId;
  if (stored.threadId !== undefined) return stored.threadId;
  return patchAgentSettings(paths, {}, options).settings.threadId;
}
