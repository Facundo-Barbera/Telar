/**
 * WHAT A RELAY CONFIG IS, with nothing around it — issue #579.
 *
 * Split out of `relay.ts` for one reason: that module reads the Keychain, so it
 * imports `node:child_process`, and the Settings pane that now VALIDATES a
 * pasted config runs in a browser. Importing the reader to reach the parser
 * would pull a Node builtin into the client bundle.
 *
 * SO THE SHAPE LIVES HERE AND THE READER IMPORTS IT, never the other way round.
 * `relay.ts` re-exports both names, so nothing that already validated a config
 * has to learn a second import path, and there is still exactly one definition
 * of what a valid one is.
 */

/** Runtime identity belongs to this Mac, never to a release artifact. */
export interface RelayConfig {
  url: string;
  token: string;
}

/**
 * A pasted config, or nothing.
 *
 * STRICT ON PURPOSE, and every clause is a way a plausible-looking paste could
 * send this Mac's push traffic somewhere it should not go: the token is exactly
 * 64 hex so a truncated copy is refused rather than stored and retried for
 * ever; the URL must be `https:` with no credentials, query, fragment or path,
 * because the relay's routes are appended to it and a base carrying its own
 * path would silently retarget every one of them. What comes back is the
 * ORIGIN, not the string that was typed.
 */
export function parseRelayConfig(input: unknown): RelayConfig | undefined {
  if (!input || typeof input !== "object") return;
  const x = input as Record<string, unknown>;
  if (typeof x.url !== "string" || typeof x.token !== "string" || !/^[a-f0-9]{64}$/i.test(x.token)) return;
  try {
    const url = new URL(x.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    return { url: url.origin, token: x.token };
  } catch {
    return;
  }
}
