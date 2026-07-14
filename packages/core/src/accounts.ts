// The account registry: ~/.telar/accounts.json. Replaces the old hardcoded
// ACCOUNTS map. Metadata only — secrets live in credentials.json (secrets.ts).
// Absent on first run → seeded non-destructively from whatever logins already
// exist on the machine, so nothing the user already has stops working.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountProfile } from "./schemas";
import type { ProjectManifest, ProviderId } from "./schemas";
import {
  telarDir,
  getProject,
  registerProject,
  unregisterProject,
} from "./manifest";
import { deleteSecret } from "./secrets";

export interface AccountRegistry {
  version: number;
  default: string;
  accounts: AccountProfile[];
}

const accountsFile = () => path.join(telarDir(), "accounts.json");

// Expand a stored "~"-relative configDir against the CURRENT home. Mirrors the
// engine's own expandHome (engine.ts) so health checks resolve the same path
// accountEnv will hand the subprocess. Local copy — engine.ts is not this
// lane's to export from.
const expandHome = (p: string): string =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

// The inverse: rewrite an absolute dir that sits under the CURRENT home into a
// portable "~/..." token. An absolute path under a DIFFERENT home is left
// intact on purpose — on this machine it will correctly read as
// missing-config-dir rather than being silently re-homed onto a wrong login.
function toHomeRelative(p: string): string {
  if (p.startsWith("~")) return p;
  const home = os.homedir();
  if (p === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return p.startsWith(prefix) ? "~/" + p.slice(prefix.length) : p;
}

function seed(): AccountRegistry {
  // personal = the system Claude login. IMPORTANT: no configDir. Setting
  // CLAUDE_CONFIG_DIR explicitly (even to ~/.claude) hashes to a different,
  // empty macOS Keychain entry and 401s — only an unset var uses the base login.
  const accounts: AccountProfile[] = [
    { name: "personal", provider: "claude", authMode: "subscription" },
  ];
  // Store configDirs home-RELATIVE ("~/.claude-work") so the registry is
  // portable across machines/homes — expandHome resolves them at use time.
  // The existsSync gate still probes the concrete current-home path.
  if (fs.existsSync(path.join(os.homedir(), ".claude-work")))
    accounts.push({ name: "work", provider: "claude", authMode: "subscription", configDir: "~/.claude-work" });
  // Codex creds are file-based (auth.json), so pointing CODEX_HOME at the
  // existing ~/.codex login is safe and works immediately.
  if (fs.existsSync(path.join(os.homedir(), ".codex")))
    accounts.push({ name: "codex", provider: "codex", authMode: "subscription", configDir: "~/.codex" });
  return { version: 1, default: "personal", accounts };
}

function persist(reg: AccountRegistry) {
  const file = accountsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, file);
}

function load(): AccountRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(accountsFile(), "utf8");
  } catch {
    const seeded = seed();
    persist(seeded);
    return seeded;
  }
  let data: { version?: number; default?: unknown; accounts?: unknown[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return { version: 1, default: "personal", accounts: [] };
  }
  // Skip malformed entries rather than throwing — a bad hand-edit of one
  // account shouldn't take down the whole app.
  const accounts = (data.accounts ?? [])
    .map((a) => AccountProfile.safeParse(a))
    .flatMap((r) => (r.success ? [r.data] : []));
  // Migrate-on-load: fold absolute current-home configDirs down to "~/..." so
  // stale registries become portable without a manual edit. Foreign-home
  // absolute paths are untouched (see toHomeRelative). Persist only when
  // something actually changed to avoid rewriting on every read.
  let migrated = false;
  for (const a of accounts) {
    if (!a.configDir) continue;
    const rel = toHomeRelative(a.configDir);
    if (rel !== a.configDir) {
      a.configDir = rel;
      migrated = true;
    }
  }
  const def =
    typeof data.default === "string" ? data.default : accounts[0]?.name ?? "personal";
  const reg = { version: data.version ?? 1, default: def, accounts };
  if (migrated) persist(reg);
  return reg;
}

export function listAccounts(): AccountProfile[] {
  return load().accounts;
}

export function getAccount(name: string): AccountProfile | undefined {
  return load().accounts.find((a) => a.name === name);
}

export function getDefaultAccountName(): string {
  return load().default;
}

export function setDefaultAccount(name: string): void {
  const reg = load();
  if (!reg.accounts.some((a) => a.name === name))
    throw new Error(`Unknown account "${name}" — not in the registry.`);
  reg.default = name;
  persist(reg);
}

export function upsertAccount(profile: AccountProfile): AccountProfile {
  const parsed = AccountProfile.parse(profile);
  const reg = load();
  const i = reg.accounts.findIndex((a) => a.name === parsed.name);
  if (i >= 0) reg.accounts[i] = parsed;
  else reg.accounts.push(parsed);
  persist(reg);
  return parsed;
}

// Removes the registry entry and any stored token. Never touches the account's
// configDir on disk — that's the user's login data, not ours to delete.
export function removeAccount(name: string): boolean {
  const reg = load();
  const i = reg.accounts.findIndex((a) => a.name === name);
  if (i < 0) return false;
  reg.accounts.splice(i, 1);
  if (reg.default === name) reg.default = reg.accounts[0]?.name ?? "personal";
  persist(reg);
  deleteSecret(name);
  return true;
}

// --- Liveness -------------------------------------------------------------
//
//  ok                → a login for this account is present on THIS machine.
//  missing-config-dir→ the account pins a configDir that doesn't exist here
//                      (a foreign-home path, or a machine that never set it up).
//  never-logged-in   → the config dir exists but holds no login artifact.
//  unknown           → nothing on disk can prove it either way (a base login
//                      whose token is in the OS keychain, not a file).
//
// This is a PURE, read-only classifier: it inspects cheap fs FACTS (does a dir
// exist; does the provider's login artifact exist) and never mutates anything,
// never spawns a subprocess, and NEVER reads the artifact's contents (it holds
// secrets — presence only).
export type AccountHealthStatus =
  | "ok"
  | "missing-config-dir"
  | "never-logged-in"
  | "unknown";

export interface AccountHealth {
  status: AccountHealthStatus;
  detail: string;
}

// The cheapest on-disk proof a provider's login completed — checked for
// EXISTENCE ONLY. Codex writes file-based creds (auth.json), so its presence is
// definitive. Claude keeps creds in the macOS Keychain keyed per config dir;
// `.credentials.json` only exists on file-cred platforms, so its ABSENCE can't
// distinguish keychain-logged-in from never-logged-in — we report "unknown".
const LOGIN_ARTIFACT: Record<ProviderId, string> = {
  claude: ".credentials.json",
  codex: "auth.json",
};

export function accountHealth(account: AccountProfile): AccountHealth {
  const provider: ProviderId = account.provider ?? "claude";

  // Base login (e.g. "personal"): no configDir by design — the creds live in
  // the provider's base keychain entry with nothing on disk to inspect. Honest.
  if (!account.configDir) {
    return {
      status: "unknown",
      detail: "Base login — sign-in state can't be verified from disk.",
    };
  }

  const dir = expandHome(account.configDir);
  if (!fs.existsSync(dir)) {
    return {
      status: "missing-config-dir",
      detail: "Config directory not found on this machine.",
    };
  }

  if (fs.existsSync(path.join(dir, LOGIN_ARTIFACT[provider]))) {
    return { status: "ok", detail: "Logged in on this machine." };
  }

  if (provider === "codex") {
    // Codex is purely file-based: no auth.json ⇒ definitively not logged in.
    return {
      status: "never-logged-in",
      detail: "Config directory exists but holds no Codex login (auth.json missing).",
    };
  }

  // Claude with a config dir but no file creds: on macOS the token is in the
  // Keychain, not on disk, so logged-in and never-logged-in look identical here.
  return {
    status: "unknown",
    detail:
      "Config directory present; Claude keeps credentials in the Keychain, so sign-in can't be confirmed from disk.",
  };
}

// Portability helper (no UI yet — PENDING): a project's checkout moved to
// `newRoot`; update the registry to point there. Uses only the public manifest
// API — getProject validates the old name exists (throws if unknown), then
// registerProject reads the telar.yaml at the new location and upserts by its
// manifest name (preserving addedAt when the key is unchanged). If the moved
// project's name differs from the old registry key, the stale key is dropped.
export function relocateProject(name: string, newRoot: string): ProjectManifest {
  getProject(name); // throws "Unknown project" if the old entry is absent
  const manifest = registerProject(newRoot); // points the entry at newRoot
  if (manifest.name !== name) unregisterProject(name);
  return manifest;
}
