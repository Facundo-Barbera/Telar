/**
 * PROVISIONING THIS MAC'S PUSH RELAY — issue #579.
 *
 * ── WHY THE SHELL AND NOT THE SERVER ────────────────────────────────────────
 * The cockpit's server READS this item (`apps/web/lib/mobile/relay.ts`) and
 * must never be able to write one: it is the process that answers requests from
 * every paired phone, and a route that could mint the credential every push
 * rides on is a much larger thing to get right than a route that can only spend
 * it. Writing is a deliberate act taken in the Settings window of the app on
 * the machine itself, so it goes through the shell — which owns no request
 * surface at all.
 *
 * ── THE SECRET IS NEVER AN ARGUMENT ─────────────────────────────────────────
 * `security add-generic-password -w <value>` puts the relay token in this
 * process's argv, where every other process this user runs can read it out of
 * `ps` for as long as the write takes. Passing `-w` with NO value makes
 * `security` read the password from stdin instead — twice, because it asks for
 * a confirmation — and that is what this does. Nothing here logs, echoes or
 * returns the value, and the error paths return `security`'s exit status rather
 * than its output for the same reason.
 *
 * ── AND IT IS VALIDATED BEFORE IT IS WRITTEN ────────────────────────────────
 * The renderer validates a pasted config with the cockpit's own
 * `parseRelayConfig`, which is the single definition of the shape. This
 * re-checks the narrow structural facts anyway — an https origin with no path,
 * a 64-hex token — because a Keychain item written from unchecked input would
 * be a credential this Mac hands to whatever host string got in.
 */
"use strict";
const { spawn } = require("node:child_process");

/** The item the cockpit's relay reader looks for. Both spellings live in code
 *  that must not drift; if either moves, the other stops finding it. */
const SERVICE = "com.telar.push-relay";
const ACCOUNT = "host";

/**
 * The same shape `parseRelayConfig` accepts, checked again at the boundary that
 * actually writes. Returns the normalised `{ url, token }` or `null` — never a
 * reason that quotes the input, since the input contains the token.
 */
function normalizeRelayConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { url, token } = input;
  if (typeof url !== "string" || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return null;
  return { url: parsed.origin, token };
}

/** `security`, with the password on stdin. Separated so the test can drive the
 *  argv and the bytes written without touching the real Keychain. */
function defaultSecurityExec(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code }));
    child.stdin.end(stdin);
  });
}

/**
 * Write (or replace) the relay credential in the login Keychain.
 *
 * `-U` UPDATES rather than failing on an item that already exists, so
 * re-provisioning after a relay redeploy is the same gesture as the first time.
 *
 * Answers `{ ok: true }` or `{ ok: false, error }`, where the error is a
 * sentence about what to do and never a quotation of what was pasted.
 */
async function provisionPushRelay(input, exec = defaultSecurityExec) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "The push relay credential lives in the macOS Keychain, so it can only be provisioned on a Mac." };
  }
  const config = normalizeRelayConfig(input);
  if (!config) {
    return {
      ok: false,
      error: "That is not a relay config. It must be JSON with an https url (an origin, no path) and a 64-character hex token.",
    };
  }
  const secret = JSON.stringify(config);
  let result;
  try {
    // The value twice: `security` prompts for the password and then for its
    // confirmation, and reads both from stdin when it is not a terminal.
    result = await exec(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w"], `${secret}\n${secret}\n`);
  } catch {
    return { ok: false, error: "Could not run /usr/bin/security to write the Keychain item." };
  }
  if (result.code !== 0) {
    return { ok: false, error: `The Keychain refused the write (security exited ${result.code}). Unlock the login keychain and try again.` };
  }
  return { ok: true };
}

module.exports = { provisionPushRelay, normalizeRelayConfig, SERVICE, ACCOUNT };
