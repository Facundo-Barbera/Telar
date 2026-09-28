"use strict";
const { spawn } = require("node:child_process");

const OP_NOT_INSTALLED =
  "The 1Password CLI (`op`) is not installed on this machine, so Telar cannot fill credentials. Install it and enable Settings → Developer → “Integrate with 1Password CLI” in the 1Password app.";
const OP_LOCKED =
  "1Password is locked or the CLI integration is disabled. Unlock the 1Password app (or set OP_SERVICE_ACCOUNT_TOKEN for detached use) and try again.";

const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.mx", "com.ar", "co.in", "co.kr", "com.sg", "com.hk", "com.tw", "com.cn",
]);

function registrableDomain(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return null;
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

function defaultOpExec(args) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ["PATH", "HOME", "OP_SERVICE_ACCOUNT_TOKEN", "OP_BIOMETRIC_UNLOCK_ENABLED", "XDG_CONFIG_HOME"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn("op", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

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

module.exports = { listLoginCandidates, registrableDomain, OP_NOT_INSTALLED, OP_LOCKED };
