import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../../state";
import { createProviderProber, providerProcessEnv, signInOf, statusOf } from "./instances";
import { resolveChildEnv } from "../../drivers/claude";

function knownClaudeDefault(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
}


const roots: string[] = [];
const root = (): string => {
  const directory = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), "telar-provider-")));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const store = (): EngineStore => new EngineStore(root(), () => 100);

test("a fresh install already has built-in slots with OpenCode disabled", () => {
  const instances = store().listProviderInstances();
  expect(instances.map((instance) => instance.id)).toEqual(["claude", "codex", "opencode"]);
  expect(instances.filter((instance) => instance.enabled).map((instance) => instance.id)).toEqual(["claude", "codex"]);
  expect(instances[0]?.configDir).toBeUndefined();
});

test("a sensitive value goes in, and does not come back out", () => {
  const engine = store();
  engine.saveProviderInstance({
    id: "claude_work",
    driver: "claude",
    configDir: "~/.claude-work",
    env: [
      { name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false },
      { name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true },
    ],
  });

  const listed = engine.listProviderInstances().find((instance) => instance.id === "claude_work")!;
  expect(listed.env).toEqual([
    { name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false },
    { name: "SECRET_TOKEN", value: "", sensitive: true, valueRedacted: true },
  ]);
  expect(engine.resolveProviderInstance("claude_work", "claude").env).toContainEqual({
    name: "SECRET_TOKEN",
    value: "sk-live-1234",
    sensitive: true,
  });
});

test("saving the redacted shape back keeps the stored secret", () => {
  const engine = store();
  engine.saveProviderInstance({
    id: "claude_work",
    driver: "claude",
    env: [{ name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true }],
  });
  engine.saveProviderInstance({
    id: "claude_work",
    displayName: "Work",
    env: [{ name: "SECRET_TOKEN", value: "", sensitive: true, valueRedacted: true }],
  });
  expect(engine.resolveProviderInstance("claude_work", "claude").env[0]?.value).toBe("sk-live-1234");

  engine.saveProviderInstance({ id: "claude_work", env: [{ name: "SECRET_TOKEN", value: "sk-live-5678", sensitive: true }] });
  expect(engine.resolveProviderInstance("claude_work", "claude").env[0]?.value).toBe("sk-live-5678");
  engine.saveProviderInstance({ id: "claude_work", env: [] });
  expect(engine.resolveProviderInstance("claude_work", "claude").env).toEqual([]);
});

test("null clears a field and an absent key leaves it alone", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "claude_work", driver: "claude", displayName: "Work", accentColor: "#2563eb" });
  engine.saveProviderInstance({ id: "claude_work", enabled: false });
  const kept = engine.listProviderInstances().find((instance) => instance.id === "claude_work")!;
  expect(kept).toMatchObject({ displayName: "Work", accentColor: "#2563eb", enabled: false });

  engine.saveProviderInstance({ id: "claude_work", accentColor: null });
  expect(engine.listProviderInstances().find((instance) => instance.id === "claude_work")?.accentColor).toBeUndefined();
});

test("a login's heavy-context threshold is a whole percentage, or absent", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "claude_work", driver: "claude", contextNoticePercent: 55 });
  const read = () => engine.listProviderInstances().find((instance) => instance.id === "claude_work");
  expect(read()?.contextNoticePercent).toBe(55);

  engine.saveProviderInstance({ id: "claude_work", displayName: "Work" });
  expect(read()?.contextNoticePercent).toBe(55);

  engine.saveProviderInstance({ id: "claude_work", contextNoticePercent: null });
  expect(read()?.contextNoticePercent).toBeUndefined();
});

test("a threshold outside 1 to 100, or not a whole number, is refused rather than clamped", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "claude_work", driver: "claude" });
  for (const value of [0, 101, 70.5, -10]) {
    expect(() => engine.saveProviderInstance({ id: "claude_work", contextNoticePercent: value })).toThrow(
      /whole percentage from 1 to 100/,
    );
  }
  expect(engine.listProviderInstances().find((instance) => instance.id === "claude_work")?.contextNoticePercent).toBeUndefined();
});

test("an instance cannot change driver, and the built-in slot cannot be deleted", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "claude_work", driver: "claude" });
  expect(() => engine.saveProviderInstance({ id: "claude_work", driver: "codex" })).toThrow(EngineStateError);
  expect(() => engine.removeProviderInstance("claude")).toThrow(/built-in/);
  expect(engine.removeProviderInstance("claude_work")).toBe(true);
  expect(engine.removeProviderInstance("claude_work")).toBe(false);
});

test("an id must start with a letter, and a colour must be a colour", () => {
  const engine = store();
  expect(() => engine.saveProviderInstance({ id: "-force", driver: "claude" })).toThrow(EngineStateError);
  expect(() => engine.saveProviderInstance({ id: "9lives", driver: "claude" })).toThrow(EngineStateError);
  expect(() => engine.saveProviderInstance({ id: "ok", driver: "claude", accentColor: "blue" })).toThrow(/#rrggbb/);
  expect(() => engine.saveProviderInstance({ id: "ok", driver: "claude", configDir: "relative/path" })).toThrow(/absolute/);
  expect(() =>
    engine.saveProviderInstance({ id: "ok", driver: "claude", env: [{ name: "1BAD", value: "x", sensitive: false }] }),
  ).toThrow(EngineStateError);
});

test("a session names an instance, and a deleted one falls back rather than failing", () => {
  const engine = store();
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  engine.saveProviderInstance({ id: "codex_work", driver: "codex", configDir: "~/.codex-work" });
  const session = engine.createSession({ id: "session_one", projectId: "project_one", providerInstanceId: "codex_work" });
  expect(session).toMatchObject({ driver: "codex", providerInstanceId: "codex_work" });

  engine.removeProviderInstance("codex_work");
  expect(engine.resolveProviderInstance("codex_work", "codex").id).toBe("codex");
  expect(engine.resolveProviderInstance("codex:default", "claude").id).toBe("claude");
});

test("a switched-off instance refuses a new session, and an unknown one is a 404", () => {
  const engine = store();
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  engine.saveProviderInstance({ id: "claude", enabled: false });
  expect(() => engine.createSession({ projectId: "project_one", providerInstanceId: "claude" })).toThrow(/switched off/);
  expect(() => engine.createSession({ projectId: "project_one", providerInstanceId: "nobody" })).toThrow(/does not exist/);
});

test("the claim carries the resolved instance, secrets included", () => {
  const engine = store();
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  engine.saveProviderInstance({ id: "claude", env: [{ name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true }] });
  engine.createSession({ id: "session_one", projectId: "project_one" });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = engine.claimNextTurn("worker_one");
  expect(claim?.providerInstance?.env).toEqual([{ name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true }]);
});

test("the built-in slot scrubs nothing; a configured instance scrubs what it owns", () => {
  const at = 100;
  const base = { id: "claude", driver: "claude" as const, enabled: true, env: [], createdAt: at, updatedAt: at };
  expect(providerProcessEnv(base)).toEqual({});

  const work = { ...base, id: "claude_work", configDir: "~/.claude-work" };
  const patch = providerProcessEnv(work);
  expect(patch.ANTHROPIC_API_KEY).toBeUndefined();
  expect("ANTHROPIC_API_KEY" in patch).toBe(true);
  expect(patch.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude-work"));
});

test("declaring an owned variable still works — only inheriting it stops", () => {
  const at = 100;
  const patch = providerProcessEnv({
    id: "claude_proxy",
    driver: "claude",
    enabled: true,
    env: [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false }],
    createdAt: at,
    updatedAt: at,
  });
  expect(patch.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
});

const PROXIED = {
  PATH: "/usr/bin",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_AUTH_TOKEN: "sk-ant-not-a-real-token",
} as const;

const DOCK = { PATH: "/usr/bin" } as const;

const storeWith = (ambient: Record<string, string | undefined>): EngineStore =>
  new EngineStore(root(), () => 100, { ambientEnv: ambient });

const childEnv = (engine: EngineStore, id: string, driver: "claude" | "codex" | "opencode", ambient: Record<string, string | undefined>) =>
  resolveChildEnv(ambient, providerProcessEnv(engine.resolveProviderInstance(id, driver)))!;

test("a login gaining its first variable reports what it stops inheriting, by name", () => {
  const engine = storeWith(PROXIED);
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });

  expect(saved.stoppedInheriting).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]);
  expect(childEnv(engine, "claude", "claude", PROXIED)).toEqual({ PATH: "/usr/bin", DISABLE_AUTO_COMPACT: "1" });

  const answer = JSON.stringify(saved);
  expect(answer).not.toContain(PROXIED.ANTHROPIC_AUTH_TOKEN);
  expect(answer).not.toContain(PROXIED.ANTHROPIC_BASE_URL);
  expect(saved.stoppedInheriting.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))).toBe(true);
  expect(saved.instance.env).toEqual([{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }]);
});

test("with a clean environment there is nothing to report", () => {
  const engine = storeWith(DOCK);
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });
  expect(saved.stoppedInheriting).toEqual([]);
});

test("carrying a variable over declares it, and the child keeps the value it had", () => {
  const engine = storeWith(PROXIED);
  const before = childEnv(engine, "claude", "claude", PROXIED);
  expect(before.ANTHROPIC_BASE_URL).toBe(PROXIED.ANTHROPIC_BASE_URL);

  engine.saveProviderInstance({ id: "claude", env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }] });
  const carried = engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_BASE_URL"] });

  const after = childEnv(engine, "claude", "claude", PROXIED);
  expect(after.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
  expect(after.DISABLE_AUTO_COMPACT).toBe("1");
  expect("CLAUDE_CODE_USE_BEDROCK" in after).toBe(false);
  expect(carried.stoppedInheriting).toEqual([]);
});

test("a login that is already configured loses nothing by gaining a second variable", () => {
  const engine = storeWith(PROXIED);
  engine.saveProviderInstance({ id: "claude", env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }] });
  const second = engine.saveProviderInstance({
    id: "claude",
    env: [
      { name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false },
      { name: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL", value: "1", sensitive: false },
    ],
  });
  expect(second.stoppedInheriting).toEqual([]);
});

test("a config folder is a transition too, and the folder's own variable is not a loss", () => {
  const engine = storeWith(PROXIED);
  const saved = engine.saveProviderInstance({ id: "claude_work", driver: "claude", configDir: "~/.claude-work" });
  expect(saved.stoppedInheriting).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]);
});

test("a variable the same save declares is not reported as lost", () => {
  const engine = storeWith(PROXIED);
  const saved = engine.saveProviderInstance({
    id: "claude_proxy",
    driver: "claude",
    env: [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false }],
  });
  expect(saved.stoppedInheriting).not.toContain("ANTHROPIC_BASE_URL");
  expect(childEnv(engine, "claude_proxy", "claude", PROXIED).ANTHROPIC_BASE_URL).toBe("https://proxy.example");
});

test("a carried-over credential is stored as a secret and does not come back", () => {
  const engine = storeWith(PROXIED);
  engine.saveProviderInstance({ id: "claude", env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }] });
  engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_AUTH_TOKEN"] });

  const listed = engine.listProviderInstances().find((instance) => instance.id === "claude")!;
  expect(listed.env).toContainEqual({ name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true });
  expect(JSON.stringify(listed)).not.toContain(PROXIED.ANTHROPIC_AUTH_TOKEN);
  expect(childEnv(engine, "claude", "claude", PROXIED).ANTHROPIC_AUTH_TOKEN).toBe(PROXIED.ANTHROPIC_AUTH_TOKEN);
});

test("a carry-over that would have to guess is refused rather than guessed", () => {
  const engine = storeWith(PROXIED);
  expect(() => engine.saveProviderInstance({ id: "claude", carryOverInherited: ["OPENAI_API_KEY"] })).toThrow(/claude login owns/);
  expect(() => engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_API_KEY"] })).toThrow(/not inheriting/);
  expect(() =>
    engine.saveProviderInstance({
      id: "claude",
      env: [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false }],
      carryOverInherited: ["ANTHROPIC_BASE_URL"],
    }),
  ).toThrow(/already declared/);
  expect(() => engine.saveProviderInstance({ id: "claude", carryOverInherited: "ANTHROPIC_BASE_URL" })).toThrow(/array of variable names/);
});

test("an empty inherited value is not an inheritance", () => {
  const engine = storeWith({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "   " });
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });
  expect(saved.stoppedInheriting).toEqual([]);
});

test("sign-in is read from the filesystem, and never asserts more than it knows", () => {
  const dir = root();
  expect(signInOf({ driver: "claude", configDir: dir }).signIn).toBe("unknown");
  expect(signInOf({ driver: "codex", configDir: dir }).signIn).toBe("signed-out");
  fs.writeFileSync(path.join(dir, "auth.json"), "{}");
  expect(signInOf({ driver: "codex", configDir: dir }).signIn).toBe("signed-in");
  expect(signInOf({ driver: "codex", configDir: path.join(dir, "nope") }).signIn).toBe("missing-config-dir");
  expect(signInOf({ driver: "claude" }).signIn).toBe("unknown");
});

test("disabled outranks every other status", () => {
  expect(statusOf({ enabled: false, installed: false, signIn: "missing-config-dir" })).toBe("disabled");
  expect(statusOf({ enabled: true, installed: false, signIn: "signed-in" })).toBe("error");
  expect(statusOf({ enabled: true, installed: true, signIn: "signed-out" })).toBe("warning");
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown" })).toBe("ready");
});

test("a CLI that is installed AND unusable is an error, not a green tick", () => {
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown", usable: false })).toBe("error");
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown" })).toBe("ready");
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown", usable: true })).toBe("ready");
  expect(statusOf({ enabled: false, installed: true, signIn: "unknown", usable: false })).toBe("disabled");
});

test("what the CLI resolution says outranks the sign-in note", async () => {
  const prober = createProviderProber({
    version: async () => ({
      installed: true,
      version: "2.1.229",
      message: "Claude Code 2.1.229 differs from the 2.1.224 this build was tested against.",
      usable: true,
    }),
    now: () => 500,
  });
  const [probe] = await prober([
    { id: "claude", driver: "claude", enabled: true, env: [], createdAt: 1, updatedAt: 1 },
  ]);
  expect(probe?.message).toContain("2.1.224");
  expect(probe?.status).toBe("ready");
});

test("one version probe serves every instance of a driver", async () => {
  const calls: string[] = [];
  const prober = createProviderProber({
    version: async (driver) => {
      calls.push(driver);
      return driver === "claude" ? { installed: true, version: "2.1.0" } : { installed: false, message: "not found" };
    },
    now: () => 500,
  });
  const at = 100;
  const instance = (id: string, driver: "claude" | "codex", over = {}) => ({
    id,
    driver,
    enabled: true,
    env: [],
    createdAt: at,
    updatedAt: at,
    ...over,
  });
  const probes = await prober([instance("claude", "claude"), instance("claude_work", "claude"), instance("codex", "codex")]);
  expect(calls).toEqual(["claude", "codex"]);
  expect(probes.map((probe) => probe.status)).toEqual(["ready", "ready", "error"]);
  expect(probes[0]).toMatchObject({ instanceId: "claude", version: "2.1.0", checkedAt: 500 });
  expect(probes[2]?.message).toBe("not found");
});

test("two logins on the same driver get separate probes when they pin separate binaries", async () => {
  const asked: Array<string | undefined> = [];
  const prober = createProviderProber({
    version: async (_driver, binaryPath) => {
      asked.push(binaryPath);
      return { installed: true, version: binaryPath ? "2.2.0" : "2.1.232" };
    },
    now: () => 500,
  });
  const at = 100;
  const instance = (id: string, over = {}) => ({ id, driver: "claude" as const, enabled: true, env: [], createdAt: at, updatedAt: at, ...over });

  const probes = await prober([instance("claude"), instance("claude_work"), instance("claude_beta", { binaryPath: "/opt/beta/claude" })]);
  expect(asked).toEqual([undefined, "/opt/beta/claude"]);
  expect(probes.map((probe) => probe.version)).toEqual(["2.1.232", "2.1.232", "2.2.0"]);
});

function upgradedFrom526(directory: string, key = "sk-from-526"): void {
  fs.writeFileSync(
    path.join(directory, "provider-instances.json"),
    JSON.stringify({
      version: 2,
      providerInstances: [
        { id: "claude", driver: "claude", enabled: true, env: [], createdAt: 1, updatedAt: 1 },
        { id: "codex", driver: "codex", enabled: true, env: [], createdAt: 1, updatedAt: 1 },
        { id: "opencode", driver: "opencode", enabled: true, env: [], createdAt: 1, updatedAt: 1 },
        {
          id: "telar",
          driver: "telar",
          enabled: true,
          env: [{ name: "OPENCODE_API_KEY", value: "", sensitive: true }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(directory, "provider-secrets.json"),
    JSON.stringify({ version: 2, secrets: { [`telar OPENCODE_API_KEY`]: key } }),
  );
}

test("a registry naming a driver this build retired still reads", () => {
  const directory = root();
  upgradedFrom526(directory);
  const engine = new EngineStore(directory, () => 100);

  expect(engine.listProviderInstances().map((instance) => instance.id)).toEqual(["claude", "codex", "opencode"]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(directory, "provider-instances.json"), "utf8"));
  expect(onDisk.providerInstances.map((instance: { id: string }) => instance.id)).toEqual(["claude", "codex", "opencode"]);
});

test("the read drops the retired row but will not touch its key", () => {
  const directory = root();
  upgradedFrom526(directory);
  const engine = new EngineStore(directory, () => 100);

  engine.listProviderInstances();
  const secrets = JSON.parse(fs.readFileSync(path.join(directory, "provider-secrets.json"), "utf8"));
  expect(secrets.secrets["telar OPENCODE_API_KEY"]).toBe("sk-from-526");
});

test("a malformed row is still corruption, and still refuses to read", () => {
  const directory = root();
  fs.writeFileSync(
    path.join(directory, "provider-instances.json"),
    JSON.stringify({
      version: 2,
      providerInstances: [{ id: "claude", driver: "claude", enabled: "yes please", env: [], createdAt: 1, updatedAt: 1 }],
    }),
  );
  expect(() => new EngineStore(directory, () => 100).listProviderInstances()).toThrow(EngineStateError);
});
