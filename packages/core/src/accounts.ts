// The account registry: ~/.telar/accounts.json. Replaces the old hardcoded
// ACCOUNTS map. Metadata only — secrets live in credentials.json (secrets.ts).
// Absent on first run → seeded non-destructively from whatever logins already
// exist on the machine, so nothing the user already has stops working.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountProfile } from "./schemas";
import { telarDir } from "./manifest";
import { deleteSecret } from "./secrets";

export interface AccountRegistry {
  version: number;
  default: string;
  accounts: AccountProfile[];
}

const accountsFile = () => path.join(telarDir(), "accounts.json");

function seed(): AccountRegistry {
  // personal = the system Claude login. IMPORTANT: no configDir. Setting
  // CLAUDE_CONFIG_DIR explicitly (even to ~/.claude) hashes to a different,
  // empty macOS Keychain entry and 401s — only an unset var uses the base login.
  const accounts: AccountProfile[] = [
    { name: "personal", provider: "claude", authMode: "subscription" },
  ];
  const work = path.join(os.homedir(), ".claude-work");
  if (fs.existsSync(work))
    accounts.push({ name: "work", provider: "claude", authMode: "subscription", configDir: work });
  // Codex creds are file-based (auth.json), so pointing CODEX_HOME at the
  // existing ~/.codex login is safe and works immediately.
  const codex = path.join(os.homedir(), ".codex");
  if (fs.existsSync(codex))
    accounts.push({ name: "codex", provider: "codex", authMode: "subscription", configDir: codex });
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
  const def =
    typeof data.default === "string" ? data.default : accounts[0]?.name ?? "personal";
  return { version: data.version ?? 1, default: def, accounts };
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
