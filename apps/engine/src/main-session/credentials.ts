/**
 * WHERE THE OPENCODE GO KEY COMES FROM — three rungs, in one place (#526).
 *
 * 1. THE KEY THE OWNER PASTED INTO TELAR. Stored through the provider-secrets
 *    pattern already in this engine: a sensitive `OPENCODE_API_KEY` on the
 *    `telar` login, which means a 0600 file the registry route never echoes
 *    back, a redacted round trip in the settings pane, and the value arriving
 *    on the claim exactly as every other provider's credential does. No new
 *    store, no new route, no second redaction to remember.
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
 * The owner asked for this rung explicitly, so that turning the Main assistant
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

/** The variable, on both the pasted rung and the ambient one — one spelling, so
 *  a person who exports it and a person who pastes it name the same thing. */
export const GO_API_KEY_VAR = "OPENCODE_API_KEY";

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
 * who typed one into Telar has said which account this machine's Main assistant
 * runs on, and an ambient variable or a CLI login must not quietly replace it.
 * That is the same ordering `providerProcessEnv` exists to protect for every
 * other provider — the instance declares, the environment does not.
 *
 * EVERY INPUT IS PASSED IN. No rung reads a global here except through a
 * default argument, so the whole ladder is testable with three fakes and the
 * test never has to have a key on the machine running it.
 */
export function resolveGoCredential(input: {
  /** The `telar` login's resolved environment — rung 1. */
  instanceEnv?: Record<string, string | undefined>;
  /** The engine or worker process's own environment — rung 2. */
  processEnv?: Record<string, string | undefined>;
  /** Rung 3, injected so a test never touches a real home directory. */
  readCliKey?: () => string | undefined;
}): GoCredential | undefined {
  const pasted = input.instanceEnv?.[GO_API_KEY_VAR]?.trim();
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
