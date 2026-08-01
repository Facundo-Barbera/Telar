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
  isMainAccount,
  isAccountEnabled,
} = await import("../src/accounts");
const { createProject, getProject } = await import("../src/manifest");
const { accountEnv } = await import("../src/engine");
const { writeSecret, readSecret } = await import("../src/secrets");
const { providerOf, PROVIDERS } = await import("../src/providers");

const accountsFile = path.join(home, "accounts.json");
const credsFile = path.join(home, "credentials.json");
// A real, existing folder to stand in for an already-signed-in config dir —
// the adoption rules reject a Claude account whose folder is not on disk.
const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-extra-"));

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(extraDir, { recursive: true, force: true });
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

  // STRUCTURAL, not behavioral: a behavioral test passes on a provider that
  // merely happens not to be exercised. Every provider must declare which env
  // vars an account owns, and — the arm that actually catches drift — every
  // credential env var a provider can SET must also be one it CLEARS. Add a new
  // auth mode with a new env var and forget this, and that var becomes
  // ambiently inheritable again: the exact hole ownedEnv exists to close.
  test("every provider clears every credential env var it can set", () => {
    for (const [id, d] of Object.entries(PROVIDERS)) {
      expect(d.ownedEnv.length).toBeGreaterThan(0);
      for (const tokenEnv of Object.values(d.tokenEnvByMode)) {
        expect(
          d.ownedEnv.includes(tokenEnv),
          `${id}: tokenEnvByMode sets ${tokenEnv} but ownedEnv does not clear it — an ambient ${tokenEnv} would survive onto an account that never declared it`,
        ).toBe(true);
      }
    }
  });

  test("every provider clears the env vars its proxy routing sets", () => {
    // Same rule as tokenEnvByMode, for the gateway: if proxyEnv can SET a var
    // that ownedEnv does not CLEAR, an ambient value survives onto an account
    // that never opted into the proxy — the exact hole ownedEnv exists to close.
    for (const [id, d] of Object.entries(PROVIDERS)) {
      for (const name of [d.proxyEnv.baseUrl, d.proxyEnv.token]) {
        expect(
          d.ownedEnv.includes(name),
          `${id}: proxyEnv sets ${name} but ownedEnv does not clear it`,
        ).toBe(true);
      }
    }
  });

  test("the config dir is guarded separately and is not double-listed", () => {
    // configDirEnv has its own set/delete branch in accountEnv; listing it in
    // ownedEnv too would delete it AFTER that branch set it, silently undoing
    // an explicit configDir.
    for (const d of Object.values(PROVIDERS)) {
      expect(d.ownedEnv).not.toContain(d.configDirEnv);
    }
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
    // A Claude account must name a config folder that EXISTS — Telar adopts
    // logins rather than creating them — so the test provides a real one.
    upsertAccount({ name: "extra", provider: "claude", authMode: "subscription", configDir: extraDir });
    expect(getAccount("extra")?.provider).toBe("claude");
    upsertAccount({
      name: "extra",
      provider: "claude",
      authMode: "api-key",
      configDir: extraDir,
      displayTier: "pro",
    });
    const updated = getAccount("extra");
    expect(updated?.authMode).toBe("api-key");
    expect(updated?.displayTier).toBe("pro");
    expect(listAccounts().filter((a) => a.name === "extra")).toHaveLength(1);
  });

  test("setDefault requires an existing account", () => {
    setDefaultAccount("extra");
    expect(getDefaultAccountName()).toBe("extra");
    expect(() => setDefaultAccount("ghost")).toThrow(/Unknown account/);
  });

  test("remove drops the entry, its secret, and reassigns the default", () => {
    writeSecret("extra", "sk-secret");
    expect(readSecret("extra")).toBe("sk-secret");
    expect(removeAccount("extra")).toBe(true);
    expect(getAccount("extra")).toBeUndefined();
    expect(readSecret("extra")).toBeUndefined();
    expect(getDefaultAccountName()).not.toBe("extra");
    expect(removeAccount("extra")).toBe(false);
  });

  // ── adoption rules ───────────────────────────────────────────────────────
  // Telar adopts logins instead of creating them, so every rule below turns a
  // silent mis-route at turn time into a refusal at add time.

  test("a new Claude account must name a config folder", () => {
    expect(() => upsertAccount({ name: "nodir", provider: "claude" })).toThrow(
      /needs its own config folder/,
    );
  });

  test("~/.claude is reserved for the main login", () => {
    // Pointing CLAUDE_CONFIG_DIR at the base login's own folder reaches a
    // DIFFERENT, empty Keychain entry — it 401s while looking correct.
    expect(() =>
      upsertAccount({ name: "shadow", provider: "claude", configDir: "~/.claude" }),
    ).toThrow(/belongs to the main Claude login/);
    expect(() =>
      upsertAccount({
        name: "shadow",
        provider: "claude",
        configDir: path.join(os.homedir(), ".claude"),
      }),
    ).toThrow(/belongs to the main Claude login/);
  });

  test("a config folder that isn't on this machine is refused", () => {
    expect(() =>
      upsertAccount({
        name: "ghostdir",
        provider: "claude",
        configDir: path.join(home, "definitely-absent"),
      }),
    ).toThrow(/No such folder on this machine/);
  });

  test("two accounts cannot share one config folder", () => {
    upsertAccount({ name: "first", provider: "claude", configDir: extraDir });
    expect(() =>
      upsertAccount({ name: "second", provider: "claude", configDir: extraDir }),
    ).toThrow(/already uses that config folder/);
    removeAccount("first");
  });

  test("Codex stays single-account until the shared-home work lands", () => {
    // seed() adds a "codex" account when ~/.codex exists on the machine running
    // the suite, so clear whatever is there to make the rule the only variable.
    for (const a of listAccounts())
      if ((a.provider ?? "claude") === "codex") removeAccount(a.name);
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cx-"));
    upsertAccount({ name: "cx1", provider: "codex", configDir: codexDir });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cx2-"));
    expect(() => upsertAccount({ name: "cx2", provider: "codex", configDir: other })).toThrow(
      /one account for now/,
    );
    // Updating the EXISTING codex account is still allowed — the rule is about
    // a second account, not about editing the one that exists.
    expect(() =>
      upsertAccount({ name: "cx1", provider: "codex", configDir: codexDir, displayTier: "plus" }),
    ).not.toThrow();
    removeAccount("cx1");
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  test("editing an existing account never re-litigates its folder", () => {
    // `personal` has no configDir by design; renaming it must not trip the
    // "a Claude account needs a folder" rule.
    expect(() =>
      upsertAccount({ name: "personal", provider: "claude", displayName: "Main" }),
    ).not.toThrow();
    expect(getAccount("personal")?.displayName).toBe("Main");
  });

  test("the main account is detected, not added — and cannot be removed", () => {
    const personal = getAccount("personal")!;
    expect(isMainAccount(personal)).toBe(true);
    expect(() => removeAccount("personal")).toThrow(/detected, not added/);
    expect(getAccount("personal")).toBeDefined();
  });

  test("enabled defaults to on, and survives an explicit switch-off", () => {
    expect(isAccountEnabled(getAccount("personal")!)).toBe(true);
    upsertAccount({ name: "personal", provider: "claude", enabled: false });
    expect(isAccountEnabled(getAccount("personal")!)).toBe(false);
    upsertAccount({ name: "personal", provider: "claude", enabled: true });
    expect(isAccountEnabled(getAccount("personal")!)).toBe(true);
  });

  test("a sensitive env var moves to the secret store; the registry keeps no value", () => {
    upsertAccount({
      name: "envy",
      provider: "claude",
      configDir: extraDir,
      env: [
        { name: "PLAIN", value: "visible", sensitive: false },
        { name: "TOKEN", value: "sk-hidden", sensitive: true },
      ],
    });
    const stored = getAccount("envy")!;
    expect(stored.env?.find((v) => v.name === "PLAIN")?.value).toBe("visible");
    // The sensitive value is blanked in the registry and lives in credentials.
    expect(stored.env?.find((v) => v.name === "TOKEN")?.value).toBe("");
    expect(readSecret("env:envy:TOKEN")).toBe("sk-hidden");
    expect(fs.readFileSync(accountsFile, "utf8")).not.toContain("sk-hidden");

    // Re-submitting the redacted (empty) value keeps the stored secret — this
    // is what makes the UI's round-trip of a value it never received safe.
    upsertAccount({
      name: "envy",
      provider: "claude",
      configDir: extraDir,
      env: [{ name: "TOKEN", value: "", sensitive: true }],
    });
    expect(readSecret("env:envy:TOKEN")).toBe("sk-hidden");

    // accountEnv resolves it back out for the subprocess.
    expect(accountEnv(getAccount("envy")).TOKEN).toBe("sk-hidden");

    // Dropping the variable deletes its secret rather than orphaning it.
    upsertAccount({ name: "envy", provider: "claude", configDir: extraDir, env: [] });
    expect(readSecret("env:envy:TOKEN")).toBeUndefined();
    removeAccount("envy");
  });

  test("removing an account takes its env secrets with it", () => {
    upsertAccount({
      name: "envgone",
      provider: "claude",
      configDir: extraDir,
      env: [{ name: "K", value: "v", sensitive: true }],
    });
    expect(readSecret("env:envgone:K")).toBe("v");
    removeAccount("envgone");
    expect(readSecret("env:envgone:K")).toBeUndefined();
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
