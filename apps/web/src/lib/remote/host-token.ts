import crypto from "node:crypto";

/**
 * THE PROCESS THAT RUNS THE SERVER DOES NOT PAIR WITH ITSELF.
 *
 * Pairing answers "may this OTHER device reach my cockpit". The desktop shell
 * is not another device — it launched the server, it owns the state directory,
 * and it already has everything pairing would grant. Making it pair was an
 * accident of the gate treating every caller alike, and it failed in the two
 * ways that hurt most: the host's own window showed "this link is missing its
 * pairing code", and anything that moved its origin (a bind-address change, a
 * tailnet URL) silently unpaired the app on the machine running it.
 *
 * SO THE SHELL CARRIES A SECRET INSTEAD OF A DEVICE RECORD. It mints one per
 * launch, hands it to the server in the child's environment, and sets it as a
 * cookie on its own Electron session before loading the page. The gate accepts
 * it as a full-role caller.
 *
 * WHY NOT A PAIRED DEVICE. The shell could write itself into remote.json — and
 * would then need this module's hashing, the device shape, and the write
 * discipline reimplemented in the shell's plain JS, free to drift from the
 * store it is imitating. A secret compared in one place duplicates nothing.
 *
 * PER LAUNCH, AND NEVER PERSISTED. It lives in the shell's memory, one child
 * environment and one session cookie, so quitting the app ends it. There is no
 * file to leak and nothing to revoke — the next launch mints another.
 */

/** The env var the shell sets on the web child. Absent for `next dev` started
 *  by hand, and absent is simply "no host here", not an error. */
export const HOST_TOKEN_ENV = "TELAR_HOST_TOKEN";

/**
 * AND THE HEADER THE SHELL PUTS ON EVERY REQUEST TO ITS OWN SERVER.
 *
 * The cookie above is seated once, on one origin, in the network service's
 * memory — and it stopped arriving in both of the ways that description
 * invites. Chromium can restart the network process, which drops every SESSION
 * cookie (persistent ones reload from disk; these do not). And the app treats
 * `localhost:<port>` and `127.0.0.1:<port>` as the same server on purpose, so a
 * navigation that spells it the other way carries no cookie at all. Either way
 * the host's own window was told to pair itself.
 *
 * A header is recomputed per request from a value the shell holds in memory, so
 * neither failure can reach it. The cookie stays — it is what the very first
 * request carries — and this is checked first.
 *
 * THE SHELL DECLARES THE SAME NAME (apps/desktop/host-header.js) and
 * apps/desktop/host-header.test.js pins that the two agree: a drift between
 * them is not a type error in either half, it is this bug again.
 */
export const HOST_HEADER = "x-telar-host";

/** The host secret off a plain Request, or null. Header first — see above. */
export function readHostHeader(request: { headers: { get(name: string): string | null } }): string | null {
  return request.headers.get(HOST_HEADER);
}

/** Long enough that guessing is not a strategy, and the same shape as a device
 *  token so nothing downstream has to special-case its parsing. */
export function mintHostToken(): string {
  return "tlr_" + crypto.randomBytes(32).toString("base64url");
}

/**
 * Constant-time, and a MISSING secret never matches. `timingSafeEqual` throws
 * on a length mismatch, so the lengths are compared first — and an empty or
 * absent env var must not turn an empty cookie into a pass.
 */
export function isHostToken(candidate: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env[HOST_TOKEN_ENV];
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(secret, "utf8"));
}
