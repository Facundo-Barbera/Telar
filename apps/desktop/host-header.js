/**
 * THE SHELL PROVES IT IS THE HOST ON EVERY REQUEST, NOT ONCE IN A JAR.
 *
 * The host secret used to travel only as a session cookie seated on
 * `session.defaultSession` before the first load (main.js `seatHostCookie`).
 * A cookie is the wrong carrier for this claim in two ways that both shipped:
 *
 *  1. A SESSION COOKIE LIVES IN THE NETWORK SERVICE'S MEMORY. When Chromium's
 *     network process is restarted — it can be, and nothing tells the app —
 *     persistent cookies reload from disk and session cookies simply do not.
 *     The window kept running with an empty jar.
 *  2. A COOKIE IS PER-ORIGIN AND THE APP HAS SEVERAL. `localhost:<port>` and
 *     `127.0.0.1:<port>` are the same server — the external-link policy says so
 *     on purpose, so that an in-app link spelled either way stays in-app — but
 *     a cookie seated on one is not sent to the other.
 *
 * Either way the proxy saw an unpaired stranger, answered 401, and bounced the
 * host's own window to the pairing page.
 *
 * A REQUEST HEADER HAS NEITHER PROPERTY. It is computed per request from a
 * value held in the main process, so there is no store to lose and no origin to
 * miss. The cookie stays as a belt — it is what a request made before this
 * listener is attached would carry — but the header is the strap.
 */

/**
 * ONE NAME, TWO LANGUAGES. The shell writes this header and `apps/web`'s gate
 * reads it (`lib/remote/host-token.ts`, which exports the same constant); a
 * disagreement between them is not a type error in either half, it is the host
 * silently unpairing itself again. `host-header.test.js` pins that the two
 * declarations say the same string.
 */
const HOST_HEADER = "x-telar-host";

/**
 * DELIBERATELY ITS OWN COPY of browser-manager.js's `LOOPBACK_HOSTS`, and not a
 * shared import. That set decides which navigations stay in-app; this one
 * decides who gets handed a credential. Widening the first must never widen the
 * second by accident, so the two rules are written out separately and each is
 * changed on its own evidence.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseUrl(value) {
  try {
    return new URL(String(value ?? ""));
  } catch {
    return null;
  }
}

/**
 * Is `target` the very server this app is showing? Same scheme, same port, and
 * both hostnames a spelling of this machine. The port and the scheme are the
 * whole of the strictness: someone's Vite on another loopback port is a
 * different server and must never see the secret.
 */
function isOwnServer(target, appUrl) {
  const parsedTarget = parseUrl(target);
  const parsedApp = parseUrl(appUrl);
  if (!parsedTarget || !parsedApp) return false;
  if (parsedTarget.protocol !== parsedApp.protocol) return false;
  if (parsedTarget.port !== parsedApp.port) return false;
  return LOOPBACK_HOSTS.has(parsedTarget.hostname) && LOOPBACK_HOSTS.has(parsedApp.hostname);
}

/**
 * Attach the header to one session's outgoing requests. THE SESSION IS AN
 * ARGUMENT AND THE CALLER PASSES `session.defaultSession` — never a browser
 * partition. Those are the integrated browser's tabs: pages the user and agents
 * point at the open web, which have no business carrying this app's credential
 * even when a tab happens to be aimed at loopback.
 *
 * Returns whether the listener was attached, so a caller with no token or an
 * unusable URL can say so rather than believe it is protected.
 */
function attachHostHeader(targetSession, { appUrl, token, header = HOST_HEADER } = {}) {
  if (!targetSession?.webRequest || !token || !parseUrl(appUrl)) return false;
  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isOwnServer(details.url, appUrl)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({ requestHeaders: { ...details.requestHeaders, [header]: token } });
  });
  return true;
}

module.exports = { HOST_HEADER, isOwnServer, attachHostHeader };
