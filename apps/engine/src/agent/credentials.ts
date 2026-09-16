/**
 * WHERE THE OPENCODE GO KEY COMES FROM — three rungs, in one place (#526).
 *
 * ── MOVED, AND RUNG 1 REHOUSED (#531) ───────────────────────────────────────
 * This lived in `main-session/` while the coordinator was a designated session.
 * Rungs 2 and 3 are unchanged — same variable, same file, same rules. Rung 1
 * moved, because the place it used to live is gone: the pasted key was a
 * sensitive variable on the `telar` provider LOGIN, and `telar` is no longer a
 * `ProviderDriverKind`. A login that is not a driver would be a row in the
 * Providers pane that nothing runs, which is the thing #531 removed the driver
 * to avoid.
 *
 * So the Agent's key has its own 0600 file beside its own thread, and the
 * settings surface is the Agent's own rather than the Providers pane's. What is
 * NOT lost is a key somebody already pasted under #526: `carryOverLegacyKey`
 * moves it across on first read, once, so nobody re-pastes.
 *
 * 1. THE KEY THE OWNER PASTED INTO TELAR, at `<engineRoot>/agent/credentials.json`,
 *    mode 0600, written only through `writeAgentKey` and read back to a client
 *    only as the boolean `set`. Never echoed, not even redacted: there is no
 *    round trip to preserve, because the only field is one a person retypes.
 * 2. `OPENCODE_API_KEY` IN THE ENGINE'S OWN ENVIRONMENT. What a person who
 *    already exports it for other tools expects to just work.
 * 3. THE OPENCODE CLI'S OWN CREDENTIAL, at `~/.local/share/opencode/auth.json`,
 *    entry `opencode-go` of shape `{ type: "api", key }`.
 *
 * ── RUNG 3 IS DELIBERATE, AND IT IS NOT THIS ENGINE'S HABIT ─────────────────
 * `../provider-instances.ts` opens the header comment "NO CREDENTIAL IS EVER
 * OPENED" and means it: that module answers "is this login signed in" with
 * `existsSync` and never a read, because scraping a credential to DISPLAY
 * something about it turns a file-format change into a confident wrong answer.
 *
 * This is a different act and the difference is the whole justification. The
 * key is not being inspected, summarised or shown — it is being SPENT, at the
 * moment of the call, on the one API the user has already pointed the CLI at.
 * The owner asked for this rung explicitly, so that turning the Agent
 * on does not mean re-pasting a key the machine already holds. The rules that
 * keep it honest are the ones below.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 * READ AT CALL TIME, NEVER COPIED. Nothing here writes; a key found on rung 3
 * stays where the CLI put it, so revoking it in the CLI revokes it for Telar.
 * There is no cache, because a cache is a copy with a nicer name.
 *
 * NEVER LOGGED, NEVER RETURNED TO A CLIENT, NEVER IN A MESSAGE. `describe` is
 * what a diagnostic is allowed to say: which rung answered, and nothing else.
 * The key itself leaves this module only towards an `Authorization` header.
 *
 * PER ENGINE, WHICH IS PER USER HERE. Every rung reads this process's own
 * environment and this user's own home; nothing is shared between accounts and
 * nothing is pooled.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../atomic";

/** The variable, on both the pasted rung and the ambient one — one spelling, so
 *  a person who exports it and a person who pastes it name the same thing. */
export const GO_API_KEY_VAR = "OPENCODE_API_KEY";

/* ------------------------------------------------------------------ *
 * RUNG 1 — the key this machine was given, in a file of its own.
 * ------------------------------------------------------------------ */

/** `<engineRoot>/agent/credentials.json`. Its own file rather than a field on
 *  `agent.json` for `providerSecrets`' own reason: the settings document is
 *  handed to every client that opens the pane, and a key stored on it would be
 *  one redaction away from being echoed back to a browser. */
export function agentKeyFile(agentDir: string): string {
  return path.join(agentDir, "credentials.json");
}

/**
 * The pasted key, or nothing.
 *
 * NEVER THROWS, for `readOpenCodeCliKey`'s reason one rung down: an absent,
 * unreadable or malformed file simply means this rung has no key, and the next
 * one is the answer. An exception here would take down a turn over a file the
 * person may never have written.
 */
export function readAgentKey(agentDir: string): string | undefined {
  try {
    const stored = JSON.parse(fs.readFileSync(agentKeyFile(agentDir), "utf8")) as { key?: unknown };
    const key = typeof stored.key === "string" ? stored.key.trim() : "";
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store a key, or clear it.
 *
 * AN EMPTY STRING CLEARS, which is what a person emptying the field means; the
 * file is left in place holding nothing rather than deleted, so its mode and
 * its existence are one less thing to re-derive.
 *
 * 0600 IS PASSED EXPLICITLY even though it is `atomicWrite`'s default, because
 * this is the one file in `agent/` where the mode is the point.
 */
export function writeAgentKey(agentDir: string, key: string | undefined): void {
  const trimmed = key?.trim();
  atomicWrite(agentKeyFile(agentDir), trimmed ? { key: trimmed } : {}, 0o600);
}

/**
 * CARRY A #526 KEY ACROSS, ONCE.
 *
 * A person who pasted an OpenCode Go key while the Main assistant existed
 * stored it as a sensitive variable on the `telar` provider login. That login
 * is gone with the driver kind, and asking them to paste the same key a second
 * time would be the upgrade losing something it did not have to.
 *
 * ONLY WHEN THIS RUNG IS EMPTY. A key set here is the person's newer answer and
 * must not be overwritten by one the old pane happened to still hold. Returns
 * whether it moved anything, so a startup can say so out loud — a silent
 * migration is indistinguishable from nothing having happened.
 */
export function carryOverLegacyKey(agentDir: string, legacy: string | undefined): boolean {
  const key = legacy?.trim();
  if (!key) return false;
  if (readAgentKey(agentDir)) return false;
  writeAgentKey(agentDir, key);
  return true;
}

/** Which rung answered. The only thing about a key that may be shown. */
export type GoKeySource = "setting" | "environment" | "cli";

export type GoCredential = { key: string; source: GoKeySource };

/** Where the OpenCode CLI keeps its own credentials. Read, never written. */
export function openCodeAuthFile(home: string = os.homedir()): string {
  return path.join(home, ".local", "share", "opencode", "auth.json");
}

/**
 * The CLI's `opencode-go` key, or nothing.
 *
 * EVERY FAILURE IS "nothing": no file, unreadable, not JSON, no such entry, a
 * different `type`, an empty key. None of them is worth an error — the caller
 * simply has no key on this rung, and the next one (or the setup field) is the
 * answer. An exception here would take down a turn over a file the user may
 * never have heard of.
 *
 * THE `type` IS CHECKED. The CLI stores OAuth entries in the same document with
 * a different shape; treating one as an API key would send a token to an
 * endpoint that wants a key and report the 401 as the user's fault.
 */
export function readOpenCodeCliKey(file: string = openCodeAuthFile()): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entry = (parsed as Record<string, unknown>)["opencode-go"];
  if (typeof entry !== "object" || entry === null) return undefined;
  const row = entry as { type?: unknown; key?: unknown };
  if (row.type !== "api" || typeof row.key !== "string") return undefined;
  const key = row.key.trim();
  return key ? key : undefined;
}

/**
 * The three rungs, most specific first.
 *
 * THE PASTED KEY IS THE EXPLICIT OVERRIDE and therefore wins outright: a person
 * who typed one into Telar has said which account this machine's Agent
 * runs on, and an ambient variable or a CLI login must not quietly replace it.
 * That is the same ordering `providerProcessEnv` protects for every other
 * provider — the setting declares, the environment does not.
 *
 * EVERY INPUT IS PASSED IN. No rung reads a global here except through a
 * default argument, so the whole ladder is testable with three fakes and the
 * test never has to have a key on the machine running it.
 */
export function resolveGoCredential(input: {
  /** `<engineRoot>/agent` — rung 1 reads `credentials.json` inside it. Absent
   *  in a test that only wants the two ambient rungs. */
  agentDir?: string;
  /** The engine or worker process's own environment — rung 2. */
  processEnv?: Record<string, string | undefined>;
  /** Rung 3, injected so a test never touches a real home directory. */
  readCliKey?: () => string | undefined;
}): GoCredential | undefined {
  const pasted = input.agentDir ? readAgentKey(input.agentDir) : undefined;
  if (pasted) return { key: pasted, source: "setting" };
  const ambient = (input.processEnv ?? process.env)[GO_API_KEY_VAR]?.trim();
  if (ambient) return { key: ambient, source: "environment" };
  const cli = (input.readCliKey ?? (() => readOpenCodeCliKey()))()?.trim();
  if (cli) return { key: cli, source: "cli" };
  return undefined;
}

/**
 * WHAT A DIAGNOSTIC MAY SAY ABOUT A KEY. Never the key, never a prefix of it,
 * never its length — all three are how a secret ends up in a log one redaction
 * pass later. Only which rung answered, which is the one fact that helps
 * somebody work out why the wrong account is being billed.
 */
export function describeGoCredential(credential: GoCredential | undefined): string {
  if (!credential) return "no OpenCode Go key is configured";
  if (credential.source === "setting") return "using the OpenCode Go key from Telar's settings";
  if (credential.source === "environment") return `using the OpenCode Go key from ${GO_API_KEY_VAR}`;
  return "using the OpenCode CLI's own OpenCode Go key";
}

/**
 * Scrub a key out of anything on its way to a person.
 *
 * A BACKSTOP, NOT THE DESIGN. Nothing in this feature deliberately puts a key
 * into a message; what this defends against is a provider's own error body
 * echoing back the `Authorization` header it was sent, which is a thing servers
 * do. Applied at the one seam where a remote body becomes a turn failure.
 *
 * AN EMPTY OR ABSENT KEY SCRUBS NOTHING, rather than replacing every empty
 * string in the text with a marker.
 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;
  return text.split(key).join("[redacted]");
}
