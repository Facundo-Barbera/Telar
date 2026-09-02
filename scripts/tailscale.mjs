import { execFile } from "node:child_process";

/**
 * The Tailscale Serve helper for the dev supervisor: publish the cockpit as a
 * tailnet-private HTTPS endpoint with a real certificate, and take it down on
 * shutdown.
 *
 * Rules carried over from studying t3code's connectivity layer, each of which
 * closes a real failure:
 *  - `tailscale` is resolved off PATH only; "not installed" is a spawn error
 *    treated as "no tailscale", never a distinct probe.
 *  - RAW STDERR IS NEVER PROPAGATED OR LOGGED. `tailscale` prints tskey-…
 *    auth keys into stderr; errors carry a classification label and nothing
 *    else.
 *  - `status` is memoized (60s) and only ever invoked when serve was
 *    explicitly requested: on Mac App Store Tailscale, every spawn re-triggers
 *    a TCC consent prompt.
 *  - The serve TARGET follows the cockpit's BIND HOST. The dogfood stack
 *    binds the tailnet IP, where a hardcoded 127.0.0.1 target would proxy to
 *    a closed port — a 502 with no error anywhere.
 *  - The ts.net hostname comes from CertDomains, not DNSName: a tailnet with
 *    HTTPS certificates disabled has a DNSName and no way to serve it.
 */

export const STATUS_TIMEOUT_MS = 1_500;
export const SERVE_TIMEOUT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 2_500;
const STATUS_CACHE_TTL_MS = 60_000;

// ── pure ────────────────────────────────────────────────────────────────────

export function isTailnetIpv4(address) {
  const octets = String(address).split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Digest of `tailscale status --json`. Tolerant: fields are validated by
 *  hand, and anything missing degrades to empty rather than throwing. */
export function parseStatus(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return { dnsName: null, tailnetIps: [], certDomains: [] };
  }
  const self = raw?.Self ?? {};
  const dnsRaw = typeof self.DNSName === "string" ? self.DNSName.trim().replace(/\.$/u, "") : "";
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => isTailnetIpv4(ip)) : [];
  const certDomains = Array.isArray(raw?.CertDomains) ? raw.CertDomains.filter((d) => typeof d === "string" && d) : [];
  return { dnsName: dnsRaw || null, tailnetIps: ips, certDomains };
}

/**
 * Classify a failed `tailscale serve` WITHOUT quoting it. The label is all a
 * log may carry — stderr can contain auth keys.
 */
export function classifyServeError(stderr, exitCode) {
  const text = String(stderr ?? "");
  if (/https.{0,30}(is not|not) enabled|cert.{0,40}disabled|enable https/i.test(text)) return "https-disabled";
  if (/handler does not exist/i.test(text)) return "no-existing-handler";
  if (/not logged in|logged out|needs? login/i.test(text)) return "not-logged-in";
  if (/permission denied|access denied|must be root|operation not permitted/i.test(text)) return "permission-denied";
  return exitCode === 0 ? "none" : "unknown";
}

export function serveArgs(httpsPort, target) {
  return ["serve", "--bg", `--https=${httpsPort}`, target];
}

export function serveOffArgs(httpsPort) {
  return ["serve", `--https=${httpsPort}`, "off"];
}

/**
 * What serve should proxy TO. Loopback and wildcard binds are reachable at
 * 127.0.0.1; an explicit interface bind is reachable only at that address.
 */
export function serveTarget(webHost, webPort) {
  const wildcard = webHost === "0.0.0.0" || webHost === "::" || webHost === "[::]";
  const loopback = webHost === "127.0.0.1" || webHost === "localhost" || webHost === "::1" || webHost === "[::1]";
  const host = wildcard || loopback ? "127.0.0.1" : webHost;
  return `http://${host}:${webPort}`;
}

export function httpsBaseUrl(certDomain, httpsPort = 443) {
  return httpsPort === 443 ? `https://${certDomain}` : `https://${certDomain}:${httpsPort}`;
}

// ── impure ──────────────────────────────────────────────────────────────────

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("tailscale", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        spawnFailed: Boolean(error && (error.code === "ENOENT" || error.code === "ENOTDIR")),
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

let statusCache = null;

/** `tailscale status --json`, memoized. Null when tailscale is missing, not
 *  running, or unparseable — callers treat all three the same. */
export async function readStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_CACHE_TTL_MS) return statusCache.value;
  const result = await run(["status", "--json"], STATUS_TIMEOUT_MS);
  const value = result.ok ? parseStatus(result.stdout) : null;
  statusCache = { at: now, value };
  return value;
}

/** Registers the serve mapping (`--bg` returns once written). Returns a
 *  classification label, "none" on success. */
export async function startServe(httpsPort, target) {
  const result = await run(serveArgs(httpsPort, target), SERVE_TIMEOUT_MS);
  if (result.ok) return "none";
  if (result.spawnFailed) return "not-installed";
  return classifyServeError(result.stderr, result.exitCode);
}

/** Best-effort teardown; never throws. */
export async function stopServe(httpsPort) {
  await run(serveOffArgs(httpsPort), SERVE_TIMEOUT_MS);
}

/** Is the HTTPS endpoint actually answering? All failures collapse to false. */
export async function probeServe(baseUrl, fetchImpl = fetch) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}/api/ping`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}
