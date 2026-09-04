// Tailscale Serve for the PACKAGED shell — the CommonJS twin of
// scripts/tailscale.mjs, which is the dev launcher's and cannot be required
// from an asar. Same rules, kept in step by hand:
//   - `tailscale` is resolved off PATH only; a spawn error is "not installed".
//   - RAW STDERR IS NEVER PROPAGATED OR LOGGED: it can carry tskey-… auth keys.
//     Failures are a classification label and nothing else.
//   - `status` is spawned ONLY when serve was asked for — Mac App Store
//     Tailscale re-prompts consent per spawn.
//   - The ts.net hostname comes from CertDomains: a tailnet with HTTPS
//     certificates disabled has a DNSName and no way to serve it.
const { execFile } = require("node:child_process");

const STATUS_TIMEOUT_MS = 1_500;
const SERVE_TIMEOUT_MS = 10_000;

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

/** The first HTTPS-capable name of this node, or null when Tailscale is
 *  missing, not running, or has certificates disabled. */
async function certDomain() {
  const result = await run(["status", "--json"], STATUS_TIMEOUT_MS);
  if (!result.ok) return null;
  try {
    const raw = JSON.parse(result.stdout);
    const domains = Array.isArray(raw?.CertDomains) ? raw.CertDomains.filter((d) => typeof d === "string" && d) : [];
    return domains[0] ?? null;
  } catch {
    return null;
  }
}

function classify(stderr, exitCode) {
  const text = String(stderr ?? "");
  if (/https.{0,30}(is not|not) enabled|cert.{0,40}disabled|enable https/i.test(text)) return "https-disabled";
  if (/not logged in|logged out|needs? login/i.test(text)) return "not-logged-in";
  if (/permission denied|access denied|must be root|operation not permitted/i.test(text)) return "permission-denied";
  return exitCode === 0 ? "none" : "unknown";
}

/** `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. A label. */
async function startServe(port) {
  const result = await run(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], SERVE_TIMEOUT_MS);
  if (result.ok) return "none";
  if (result.spawnFailed) return "not-installed";
  return classify(result.stderr, result.exitCode);
}

/** Best-effort; never throws. */
async function stopServe() {
  await run(["serve", "--https=443", "off"], SERVE_TIMEOUT_MS);
}

module.exports = { certDomain, startServe, stopServe };
