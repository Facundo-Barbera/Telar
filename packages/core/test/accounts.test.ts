import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-accounts-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  listAccounts,
  getAccount,
  getDefaultAccountName,
  setDefaultAccount,
  upsertAccount,
  removeAccount,
  accountHealth,
  relocateProject,
} = await import("../src/accounts");
const { createProject, getProject } = await import("../src/manifest");
const { accountEnv } = await import("../src/engine");
const { writeSecret, readSecret } = await import("../src/secrets");
const { providerOf, PROVIDERS } = await import("../src/providers");

const accountsFile = path.join(home, "accounts.json");
const credsFile = path.join(home, "credentials.json");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("providers", () => {
  test("descriptor table maps env vars per provider", () => {
    expect(PROVIDERS.claude.configDirEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(PROVIDERS.codex.configDirEnv).toBe("CODEX_HOME");
    expect(PROVIDERS.claude.tokenEnvByMode["oauth-token"]).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(PROVIDERS.codex.tokenEnvByMode["api-key"]).toBe("OPENAI_API_KEY");
    // Codex has no subscription setup-token analogue.
    expect(PROVIDERS.codex.tokenEnvByMode["oauth-token"]).toBeUndefined();
  });

  test("providerOf defaults to claude", () => {
    expect(providerOf().id).toBe("claude");
    expect(providerOf("codex").id).toBe("codex");
  });
});

describe("account registry", () => {
  test("seeds a personal account as default on first load", () => {
    expect(fs.existsSync(accountsFile)).toBe(false);
    const def = getDefaultAccountName();
    expect(def).toBe("personal");
    expect(fs.existsSync(accountsFile)).toBe(true);
    const personal = getAccount("personal");
    expect(personal?.provider).toBe("claude");
    expect(personal?.authMode).toBe("subscription");
    // personal must NOT pin a configDir (keychain base-entry rule).
    expect(personal?.configDir).toBeUndefined();
  });

  test("upsert adds and updates by name", () => {
    upsertAccount({ name: "codex-work", provider: "codex", authMode: "subscription", configDir: "~/.codex-work" });
    expect(getAccount("codex-work")?.provider).toBe("codex");
    upsertAccount({ name: "codex-work", provider: "codex", authMode: "api-key", displayTier: "pro" });
    const updated = getAccount("codex-work");
    expect(updated?.authMode).toBe("api-key");
    expect(updated?.displayTier).toBe("pro");
    expect(listAccounts().filter((a) => a.name === "codex-work")).toHaveLength(1);
  });

  test("setDefault requires an existing account", () => {
    setDefaultAccount("codex-work");
    expect(getDefaultAccountName()).toBe("codex-work");
    expect(() => setDefaultAccount("ghost")).toThrow(/Unknown account/);
  });

  test("remove drops the entry, its secret, and reassigns the default", () => {
    writeSecret("codex-work", "sk-secret");
    expect(readSecret("codex-work")).toBe("sk-secret");
    expect(removeAccount("codex-work")).toBe(true);
    expect(getAccount("codex-work")).toBeUndefined();
    expect(readSecret("codex-work")).toBeUndefined();
    expect(getDefaultAccountName()).not.toBe("codex-work");
    expect(removeAccount("codex-work")).toBe(false);
  });

  test("malformed entries are skipped, not fatal", () => {
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({ version: 1, default: "personal", accounts: [{ name: "ok" }, { bogus: true }] }),
    );
    const names = listAccounts().map((a) => a.name);
    expect(names).toContain("ok");
    expect(names).not.toContain(undefined);
  });
});

describe("accountHealth", () => {
  test("base login (no configDir) is unknown — nothing on disk to check", () => {
    const h = accountHealth({ name: "personal", provider: "claude", authMode: "subscription" });
    expect(h.status).toBe("unknown");
  });

  test("a configDir that doesn't exist reads as missing-config-dir", () => {
    const h = accountHealth({
      name: "w",
      provider: "claude",
      configDir: path.join(home, "does-not-exist-anywhere"),
    });
    expect(h.status).toBe("missing-config-dir");
  });

  test("codex: auth.json presence toggles ok / never-logged-in (existence only, never read)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-codex-"));
    expect(accountHealth({ name: "cx", provider: "codex", configDir: dir }).status).toBe(
      "never-logged-in",
    );
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    expect(accountHealth({ name: "cx", provider: "codex", configDir: dir }).status).toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("claude: file creds ⇒ ok; dir present without them ⇒ unknown (keychain, not disk)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-claude-"));
    expect(accountHealth({ name: "c", provider: "claude", configDir: dir }).status).toBe("unknown");
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
    expect(accountHealth({ name: "c", provider: "claude", configDir: dir }).status).toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("home-relative migration", () => {
  test("an absolute current-home configDir is folded to ~/… on load; foreign-home is left intact", () => {
    const foreign = "/some/other/machine/.claude-work";
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 1,
        default: "personal",
        accounts: [
          { name: "personal", provider: "claude", authMode: "subscription" },
          { name: "mine", provider: "claude", configDir: path.join(os.homedir(), ".claude-mine") },
          { name: "theirs", provider: "claude", configDir: foreign },
        ],
      }),
    );
    expect(getAccount("mine")?.configDir).toBe("~/.claude-mine");
    expect(getAccount("theirs")?.configDir).toBe(foreign);
    // Migration is persisted, so the rewrite survives a re-read.
    const raw = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
    expect(raw.accounts.find((a: { name: string }) => a.name === "mine").configDir).toBe(
      "~/.claude-mine",
    );
  });
});

describe("relocateProject", () => {
  test("points the registry entry at the new root, preserving addedAt", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "telar-proj-src-"));
    createProject(src, { name: "movable" });
    const addedAt = getProject("movable").entry.addedAt;

    const dst = fs.mkdtempSync(path.join(os.tmpdir(), "telar-proj-dst-"));
    fs.copyFileSync(path.join(src, "telar.yaml"), path.join(dst, "telar.yaml"));

    relocateProject("movable", dst);
    const entry = getProject("movable").entry;
    expect(entry.root).toBe(path.resolve(dst));
    expect(entry.addedAt).toBe(addedAt);

    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test("throws for an unknown project", () => {
    expect(() => relocateProject("ghost-project", os.tmpdir())).toThrow(/Unknown project/);
  });
});

describe("accountEnv", () => {
  test("no account = passthrough of process.env", () => {
    const env = accountEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  test("claude subscription sets CLAUDE_CONFIG_DIR, no token", () => {
    const env = accountEnv({ name: "w", provider: "claude", authMode: "subscription", configDir: "/tmp/claude-w" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-w");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  });

  test("codex account uses CODEX_HOME, not CLAUDE_CONFIG_DIR", () => {
    const env = accountEnv({ name: "cx", provider: "codex", authMode: "subscription", configDir: "/tmp/codex-cx" });
    expect(env.CODEX_HOME).toBe("/tmp/codex-cx");
    expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  test("~ in configDir is expanded to the home dir", () => {
    const env = accountEnv({ name: "h", provider: "claude", configDir: "~/.telar/accounts/h" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".telar/accounts/h"));
  });

  test("oauth-token mode resolves the secret into the provider token env", () => {
    writeSecret("tok", "oauth-abc");
    const env = accountEnv({ name: "tok", provider: "claude", authMode: "oauth-token" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-abc");
  });

  test("an explicit tokenEnv wins over the secret store", () => {
    writeSecret("ov", "from-store");
    process.env.MY_TOKEN_SRC = "from-env";
    const env = accountEnv({ name: "ov", provider: "claude", authMode: "oauth-token", tokenEnv: "MY_TOKEN_SRC" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("from-env");
    delete process.env.MY_TOKEN_SRC;
  });

  test("codex api-key mode sets OPENAI_API_KEY", () => {
    writeSecret("cxk", "sk-openai");
    const env = accountEnv({ name: "cxk", provider: "codex", authMode: "api-key" });
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });
});
