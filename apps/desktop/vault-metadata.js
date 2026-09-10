/**
 * DOMAIN-MATCHED VAULT ITEM METADATA for the login offer — the shell's port of
 * the engine's `listLoginCandidates` (apps/engine/src/secrets/onepassword.ts).
 *
 * METADATA ONLY, BY CONSTRUCTION: the one `op` invocation here is
 * `op item list`, whose output is ids, titles, vault names and website URLs.
 * No item is ever `get`-ed, so no credential value can pass through this
 * module — the offer shows a person WHICH items match the page, and the value
 * stays in the vault until a fill the engine separately authorizes.
 *
 * The domain heuristic is the engine's, pinned against it by
 * vault-metadata.test.js so the offer lists exactly the items a later
 * `browser_fill_secret` would list.
 */
"use strict";
const { spawn } = require("node:child_process");

const OP_NOT_INSTALLED =
  "The 1Password CLI (`op`) is not installed on this machine, so Telar cannot fill credentials. Install it and enable Settings → Developer → “Integrate with 1Password CLI” in the 1Password app.";
const OP_LOCKED =
  "1Password is locked or the CLI integration is disabled. Unlock the 1Password app (or set OP_SERVICE_ACCOUNT_TOKEN for detached use) and try again.";

// The engine's short list of two-part public suffixes — see onepassword.ts for
// why this heuristic (strict, never over-grouping) instead of the PSL.
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.mx", "com.ar", "co.in", "co.kr", "com.sg", "com.hk", "com.tw", "com.cn",
]);

function registrableDomain(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return null; // IPs never match a vault item
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

function registrableDomainOfUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return registrableDomain(url.hostname);
  } catch {
    return null;
  }
}

/** The engine's allowlisted `op` runner: no inherited provider keys. */
function defaultOpExec(args) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ["PATH", "HOME", "OP_SERVICE_ACCOUNT_TOKEN", "OP_BIOMETRIC_UNLOCK_ENABLED", "XDG_CONFIG_HOME"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn("op", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", () => {}); // 1Password's prose is dropped, not relayed
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * Login items whose website matches the page's registrable domain —
 * `{ ok: true, candidates: [{ id, title, domain, vault? }] }` or
 * `{ ok: false, error }`. Same answers, same errors as the engine's listing.
 */
async function listLoginCandidates(origin, exec = defaultOpExec) {
  const domain = registrableDomainOfUrl(origin);
  if (!domain) return { ok: false, error: `Credentials can only be filled on an http(s) page with a real domain; the browser is on ${origin}.` };
  let result;
  try {
    result = await exec(["item", "list", "--categories", "Login", "--format", "json"]);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: false, error: OP_NOT_INSTALLED };
    throw error;
  }
  if (result.code !== 0) return { ok: false, error: OP_LOCKED };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "The 1Password CLI answered with something that is not JSON." };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "The 1Password CLI answered with an unexpected shape." };
  const candidates = [];
  for (const raw of parsed) {
    const id = raw && typeof raw.id === "string" ? raw.id : null;
    const title = raw && typeof raw.title === "string" ? raw.title : null;
    if (!id || !title) continue;
    const matches = (Array.isArray(raw.urls) ? raw.urls : []).some(
      (entry) => entry && typeof entry.href === "string" && registrableDomainOfUrl(entry.href) === domain,
    );
    if (!matches) continue;
    candidates.push({
      id,
      title,
      domain,
      ...(raw.vault && typeof raw.vault.name === "string" ? { vault: raw.vault.name } : {}),
    });
  }
  return { ok: true, candidates };
}

module.exports = { listLoginCandidates, registrableDomain, registrableDomainOfUrl, OP_NOT_INSTALLED, OP_LOCKED };
