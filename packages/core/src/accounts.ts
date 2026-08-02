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
import { accountEnvSecretKey, deleteSecret, writeSecret } from "./secrets";

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

// AUTO-DETECTED vs MANUAL, and the line between them. Telar no longer drives a
// login (there is no login.ts any more — see the Providers surface): it adopts
// what the machine already has. Exactly ONE Claude account is automatic — the
// MAIN one, the provider's base login — and every additional Claude account is
// a config folder the user points us at by hand. Codex gets its one default
// home; multi-account Codex is not supported yet (see assertAdmissible).
function seed(): AccountRegistry {
  // personal = the system Claude login, and it is seeded UNCONDITIONALLY rather
  // than gated on `claude` being detectable. Two reasons, both load-bearing:
  // ProjectManifest.account defaults to the literal "personal" (schemas.ts), so
  // a registry without it would leave every project pointing at an account that
  // does not exist; and whether Claude is actually installed and signed in is a
  // question the Providers probe (detect.ts) and accountHealth answer honestly,
  // which is better than a row that silently fails to exist.
  //
  // IMPORTANT: no configDir. Setting CLAUDE_CONFIG_DIR explicitly (even to
  // ~/.claude) hashes to a different, empty macOS Keychain entry and 401s —
  // only an unset var uses the base login. This is also why MAIN_CLAUDE_DIR
  // below is a REJECTED value for a manually added account.
  const accounts: AccountProfile[] = [
    { name: "personal", provider: "claude", authMode: "subscription" },
  ];
  // Codex creds are file-based (auth.json), so pointing CODEX_HOME at the
  // existing ~/.codex login is safe and works immediately. Store configDirs
  // home-RELATIVE ("~/.codex") so the registry is portable across
  // machines/homes — expandHome resolves them at use time, while the existsSync
  // gate probes the concrete current-home path.
  if (fs.existsSync(path.join(os.homedir(), ".codex", "auth.json")))
    accounts.push({ name: "codex", provider: "codex", authMode: "subscription", configDir: "~/.codex" });
  return { version: 3, default: "personal", accounts };
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
  let data: {
    version?: number;
    default?: unknown;
    accounts?: unknown[];
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return seed();
  }
  // Skip malformed entries rather than throwing — a bad hand-edit of one
  // account shouldn't take down the whole app.
  const parsedAccounts = (data.accounts ?? [])
    .map((a) => AccountProfile.safeParse(a))
    .flatMap((r) => (r.success ? [r.data] : []));
  const accounts = parsedAccounts;
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

  // Native Claude is the zero-configuration baseline and may not disappear
  // because a previous integration disabled it. It represents `claude` as the
  // user launches it normally: no config-dir or endpoint is imposed by Telar.
  let main = accounts.find((account) => isMainAccount(account));
  if (!main) {
    main = { name: "personal", provider: "claude", authMode: "subscription" };
    accounts.unshift(main);
    migrated = true;
  }
  const def =
    typeof data.default === "string" ? data.default : accounts[0]?.name ?? "personal";
  // Older registries could keep a disabled account as the default. Repair that
  // state on read, while leaving an all-disabled registry untouched so callers
  // can surface an honest configuration error.
  const repairedDefault =
    accounts.find((a) => a.name === def && a.enabled !== false)?.name ??
    accounts.find((a) => a.enabled !== false)?.name ??
    def;
  if (repairedDefault !== def) migrated = true;
  if (data.version !== 3) migrated = true;
  const reg: AccountRegistry = {
    version: 3,
    default: repairedDefault,
    accounts,
  };
  if (migrated) persist(reg);
  return reg;
}

export function listAccounts(): AccountProfile[] {
  return load().accounts;
}

export function getAccount(name: string): AccountProfile | undefined {
  return load().accounts.find((account) => account.name === name);
}

export function getDefaultAccountName(): string {
  return load().default;
}

/** Resolve an account for a brand-new session. Existing sessions deliberately
 * bypass this helper and remain locked to their persisted account. */
export function resolveEnabledAccount(
  preferred?: string,
  provider?: ProviderId,
): AccountProfile | undefined {
  const reg = load();
  if (
    preferred &&
    !reg.accounts.some((account) => account.name === preferred)
  ) {
    return undefined;
  }
  const eligible = reg.accounts.filter(
    (account) =>
      account.enabled !== false &&
      isAccountAvailableForSessions(account) &&
      (!provider || (account.provider ?? "claude") === provider),
  );
  return (
    eligible.find((account) => account.name === preferred) ??
    eligible.find((account) => account.name === reg.default) ??
    eligible[0]
  );
}

export function setDefaultAccount(name: string): void {
  const reg = load();
  const account = reg.accounts.find((a) => a.name === name);
  if (!account)
    throw new Error(`Unknown account "${name}" — not in the registry.`);
  if (account.enabled === false)
    throw new Error(`Account "${name}" is disabled and cannot be the default.`);
  reg.default = name;
  persist(reg);
}

// The main Claude login's own config folder. RESERVED, never adoptable as a
// manual account: CLAUDE_CONFIG_DIR pointing here resolves to a different,
// empty Keychain entry than the unset var does, so an account pinned to it
// 401s while looking, in the registry, exactly like the working main account.
const MAIN_CLAUDE_DIR = "~/.claude";

// The one auto-detected account: Claude's base login, identified by having no
// configDir at all. Everything else in the registry was added by hand.
//
export const isMainAccount = (a: AccountProfile): boolean =>
  (a.provider ?? "claude") === "claude" && !a.configDir;

const sameDir = (a?: string, b?: string): boolean =>
  !!a && !!b && path.resolve(expandHome(a)) === path.resolve(expandHome(b));

// Can this profile join the registry? Throws with a message written FOR THE
// USER (the API hands it straight back as a 400). Every rule here exists
// because Telar adopts logins rather than creating them: an account that names
// a folder with no login in it, or that shadows another account's folder, is a
// silent mis-route at turn time rather than an error at add time.
//
// Deliberately NOT a blanket re-validation: an account that already exists and
// is not moving its config dir passes untouched, so editing a plan label can
// never trip a rule about paths (and `personal`, the one configDir-less Claude
// account, stays editable forever).
function assertAdmissible(reg: AccountRegistry, next: AccountProfile): void {
  const prev = reg.accounts.find((a) => a.name === next.name);
  const provider: ProviderId = next.provider ?? "claude";

  // Codex is single-account FOR NOW. CODEX_HOME swaps the entire config tree —
  // sessions, history and auth together — so a second Codex account is not the
  // one-line change it is for Claude, and the investigation is still open.
  if (provider === "codex") {
    const other = reg.accounts.find(
      (a) => (a.provider ?? "claude") === "codex" && a.name !== next.name,
    );
    if (other)
      throw new Error(
        `Codex supports one account for now — "${other.name}" already holds it. Multi-account Codex is still being investigated.`,
      );
  }

  if (prev && prev.configDir === next.configDir) return;

  if (provider === "claude") {
    if (!next.configDir)
      throw new Error(
        "A Claude account needs its own config folder. The main login is the only account without one, and it is detected automatically.",
      );
    if (sameDir(next.configDir, MAIN_CLAUDE_DIR))
      throw new Error(
        `${MAIN_CLAUDE_DIR} belongs to the main Claude login. Pointing CLAUDE_CONFIG_DIR at it reaches a different, empty Keychain entry — use the main account, or a separate folder.`,
      );
  }

  if (next.configDir && !fs.existsSync(expandHome(next.configDir)))
    throw new Error(
      `No such folder on this machine: ${next.configDir}. Sign in with that folder first, then add it here.`,
    );

  const clash = reg.accounts.find(
    (a) => a.name !== next.name && sameDir(a.configDir, next.configDir),
  );
  if (clash) throw new Error(`"${clash.name}" already uses that config folder.`);
}

// An account is usable unless it was explicitly switched off. Absent ⇒ enabled,
// so a registry written before the switch existed doesn't read as all-off.
export const isAccountEnabled = (a: AccountProfile): boolean => a.enabled !== false;

/** Cheap, side-effect-free session availability derived from local artifacts. */
export function isAccountAvailableForSessions(account: AccountProfile): boolean {
  if (account.enabled === false) return false;
  const health = accountHealth(account);
  return health.status !== "missing-config-dir" && health.status !== "never-logged-in";
}

// Move every sensitive env value OFF the profile and INTO the secret store, so
// the registry keeps names and a marker but never a token. A sensitive var
// submitted with an empty value keeps whatever is already stored — that is how
// the UI round-trips a redacted field it never received the value for.
function stashSensitiveEnv(profile: AccountProfile): AccountProfile {
  if (!profile.env?.length) return profile;
  const env = profile.env.map((v) => {
    if (!v.sensitive) return v;
    const key = accountEnvSecretKey(profile.name, v.name);
    if (v.value) writeSecret(key, v.value);
    return { ...v, value: "" };
  });
  return { ...profile, env };
}

export function upsertAccount(profile: AccountProfile): AccountProfile {
  const parsed = stashSensitiveEnv(AccountProfile.parse(profile));
  const reg = load();
  assertAdmissible(reg, parsed);
  // Secrets for env vars this update DROPPED are deleted — otherwise removing a
  // variable from the UI would leave its value behind in the secret store,
  // invisible and still resolvable if the name were ever re-added.
  const prev = reg.accounts.find((a) => a.name === parsed.name);
  for (const old of prev?.env ?? []) {
    if (!old.sensitive) continue;
    if (parsed.env?.some((v) => v.name === old.name && v.sensitive)) continue;
    deleteSecret(accountEnvSecretKey(parsed.name, old.name));
  }
  const i = reg.accounts.findIndex((a) => a.name === parsed.name);
  if (i >= 0) reg.accounts[i] = parsed;
  else reg.accounts.push(parsed);
  if (reg.default === parsed.name && parsed.enabled === false) {
    reg.default = reg.accounts.find((account) => account.enabled !== false)?.name ?? reg.default;
  }
  persist(reg);
  return parsed;
}

// Removes the registry entry and any stored token. Never touches the account's
// configDir on disk — that's the user's login data, not ours to delete.
//
// Refuses on the MAIN account: it is the one entry Telar detects rather than
// the user adding, ProjectManifest.account defaults to its name, and seed()
// only runs when accounts.json is absent entirely — so removing it would strand
// every project on an account that no longer exists and never come back.
export function removeAccount(name: string): boolean {
  const reg = load();
  const i = reg.accounts.findIndex((a) => a.name === name);
  if (i < 0) return false;
  const target = reg.accounts[i];
  if (isMainAccount(target))
    throw new Error(
      `"${name}" is the main Claude login — it is detected, not added, so it can't be removed. Sign out with the Claude CLI instead.`,
    );
  const [removed] = reg.accounts.splice(i, 1);
  if (reg.default === name) reg.default = reg.accounts[0]?.name ?? "personal";
  persist(reg);
  deleteSecret(name);
  // Its sensitive env values go too — a removed account must not leave secrets
  // behind that a later account of the same name would silently inherit.
  for (const v of removed?.env ?? [])
    if (v.sensitive) deleteSecret(accountEnvSecretKey(name, v.name));
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
