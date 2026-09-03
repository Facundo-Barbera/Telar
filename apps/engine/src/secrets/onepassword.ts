/**
 * The 1Password CLI (`op`), narrowed to the two reads the credential-fill path
 * needs: list Login items that match an origin, and read one item's fields.
 *
 * WHAT THIS MODULE MUST NEVER DO is the design. Secret values exist only in
 * the return value of `readItemFields`, which the caller holds in memory for
 * the duration of one fill and never writes anywhere. Nothing here logs,
 * journals, or throws with a value in the message — every failure is a
 * human-readable sentence about the VAULT's state, not its contents.
 *
 * `op` IS OPTIONAL EQUIPMENT. On a machine without it (this one, at the time
 * of writing) every call answers a clean, actionable error instead of
 * spawning ENOENT into a stack trace. Nothing is ever installed on the
 * user's behalf.
 *
 * AUTH IS 1PASSWORD'S PROBLEM, DELIBERATELY. With the desktop app's CLI
 * integration enabled, `op` prompts Touch ID on the user's own screen; with
 * `OP_SERVICE_ACCOUNT_TOKEN` set, it works detached. This module passes
 * through exactly the env that controls that and nothing else.
 */
import { spawn } from "node:child_process";
import type { SecretCandidate, SecretFieldKind } from "@telar/engine-client";

/** One wanted value: a kind, plus the 1Password field label when `kind` is
 *  `"field"`. */
export type SecretFieldWant = { kind: SecretFieldKind; label?: string };

/** Injected so tests never spawn a real process — the same seam shape the
 *  browser transport uses. */
export type OpExec = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type SecretsListResult = { ok: true; candidates: SecretCandidate[] } | { ok: false; error: string };
export type SecretsReadResult = { ok: true; values: { want: SecretFieldWant; value: string }[] } | { ok: false; error: string };

export type SecretsProvider = {
  listLoginCandidates(origin: string): Promise<SecretsListResult>;
  readItemFields(itemId: string, wants: readonly SecretFieldWant[]): Promise<SecretsReadResult>;
};

export const OP_NOT_INSTALLED =
  "The 1Password CLI (`op`) is not installed on this machine, so Telar cannot fill credentials. Install it and enable Settings → Developer → “Integrate with 1Password CLI” in the 1Password app.";

const OP_LOCKED =
  "1Password is locked or the CLI integration is disabled. Unlock the 1Password app (or set OP_SERVICE_ACCOUNT_TOKEN for detached use) and try again.";

/**
 * The default runner: `op` from PATH, with an EXPLICIT env.
 *
 * Allowlisted rather than inherited: the worker's environment carries provider
 * API keys and whatever else the operator exported, and a child that reads
 * secrets should receive only what controls its own auth. `HOME` is where `op`
 * finds the desktop-app integration socket; the two `OP_*` variables are its
 * documented auth switches.
 */
export const defaultOpExec: OpExec = (args) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "OP_SERVICE_ACCOUNT_TOKEN", "OP_BIOMETRIC_UNLOCK_ENABLED", "XDG_CONFIG_HOME"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn("op", [...args], { stdio: ["ignore", "pipe", "pipe"] as const, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

/**
 * The registrable domain of a hostname — `login.github.com` → `github.com`.
 *
 * A HEURISTIC, STATED AS ONE. The correct answer is the Public Suffix List,
 * which is a dependency this repo does not take for PR1 (nothing may be
 * installed). The heuristic takes the last two labels, except for a short
 * explicit set of two-part public suffixes where it takes three. It can only
 * err by being STRICTER than the PSL for exotic suffixes (grouping less, so a
 * candidate fails to match), never by matching across two unrelated
 * registrable domains under a listed suffix. DECIDED: revisit with the PSL if
 * a real mismatch is reported.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.mx", "com.ar", "co.in", "co.kr", "com.sg", "com.hk", "com.tw", "com.cn",
]);

export function registrableDomain(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return null; // IPs and IPv6 never match a vault item
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

/** The registrable domain of a full origin/URL string, or null when it has
 *  none worth binding to (non-http(s), IP literals, single-label hosts). */
export function registrableDomainOfUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return registrableDomain(url.hostname);
  } catch {
    return null;
  }
}

type OpItemSummary = {
  id?: unknown;
  title?: unknown;
  vault?: { name?: unknown };
  urls?: { href?: unknown; primary?: unknown }[];
};

type OpItemField = {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  purpose?: unknown;
  value?: unknown;
  totp?: unknown;
};

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

/** Map an `op` failure to a sentence about the vault. stderr is DROPPED, not
 *  forwarded: it is 1Password's prose, and prose from a credential tool is not
 *  something to relay into a journal verbatim. */
function opFailure(): { ok: false; error: string } {
  return { ok: false, error: OP_LOCKED };
}

export function createOnePasswordSecrets(exec: OpExec = defaultOpExec): SecretsProvider {
  const run = async (args: readonly string[]): Promise<{ code: number | null; stdout: string } | { unavailable: true }> => {
    try {
      const result = await exec(args);
      return { code: result.code, stdout: result.stdout };
    } catch (error) {
      if (isEnoent(error)) return { unavailable: true };
      throw error;
    }
  };

  return {
    async listLoginCandidates(origin) {
      const domain = registrableDomainOfUrl(origin);
      if (!domain) return { ok: false, error: `Credentials can only be filled on an http(s) page with a real domain; the browser is on ${origin}.` };
      const result = await run(["item", "list", "--categories", "Login", "--format", "json"]);
      if ("unavailable" in result) return { ok: false, error: OP_NOT_INSTALLED };
      if (result.code !== 0) return opFailure();
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return { ok: false, error: "The 1Password CLI answered with something that is not JSON." };
      }
      if (!Array.isArray(parsed)) return { ok: false, error: "The 1Password CLI answered with an unexpected shape." };
      const candidates: SecretCandidate[] = [];
      for (const raw of parsed as OpItemSummary[]) {
        const id = typeof raw.id === "string" ? raw.id : null;
        const title = typeof raw.title === "string" ? raw.title : null;
        if (!id || !title) continue;
        const matches = (raw.urls ?? []).some(
          (entry) => typeof entry.href === "string" && registrableDomainOfUrl(entry.href) === domain,
        );
        if (!matches) continue;
        candidates.push({
          id,
          title,
          domain,
          ...(typeof raw.vault?.name === "string" ? { vault: raw.vault.name } : {}),
        });
      }
      return { ok: true, candidates };
    },

    async readItemFields(itemId, wants) {
      const result = await run(["item", "get", itemId, "--format", "json", "--reveal"]);
      if ("unavailable" in result) return { ok: false, error: OP_NOT_INSTALLED };
      if (result.code !== 0) return opFailure();
      let parsed: { fields?: OpItemField[] };
      try {
        parsed = JSON.parse(result.stdout) as { fields?: OpItemField[] };
      } catch {
        return { ok: false, error: "The 1Password CLI answered with something that is not JSON." };
      }
      const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
      const values: { want: SecretFieldWant; value: string }[] = [];
      for (const want of wants) {
        const field = fields.find((candidate) => matchesWant(candidate, want));
        const value = field ? valueOf(field) : null;
        // The MISSING field is named by kind/label, never by anything read
        // from the item — an error message is journal-bound text.
        if (value === null) {
          return { ok: false, error: `The chosen 1Password item has no ${want.kind === "field" ? `field labelled “${want.label ?? ""}”` : want.kind}.` };
        }
        values.push({ want, value });
      }
      return { ok: true, values };
    },
  };
}

function matchesWant(field: OpItemField, want: SecretFieldWant): boolean {
  const purpose = typeof field.purpose === "string" ? field.purpose : "";
  const type = typeof field.type === "string" ? field.type : "";
  const label = typeof field.label === "string" ? field.label : "";
  switch (want.kind) {
    case "username":
      return purpose === "USERNAME";
    case "password":
      return purpose === "PASSWORD";
    case "otp":
      return type === "OTP";
    case "field":
      return want.label !== undefined && label.toLowerCase() === want.label.toLowerCase();
  }
}

function valueOf(field: OpItemField): string | null {
  // OTP fields carry the current code in `totp`; everything else in `value`.
  if (typeof field.totp === "string" && field.totp.length > 0) return field.totp;
  return typeof field.value === "string" && field.value.length > 0 ? field.value : null;
}
