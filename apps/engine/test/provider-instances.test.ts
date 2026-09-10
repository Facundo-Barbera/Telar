/**
 * The account registry and what the machine says about it.
 *
 * The properties worth pinning are the ones a settings page can silently
 * violate: a secret must not come back out of the store, a redacted round trip
 * must not erase it, and a probe must never claim somebody is signed out when
 * all it actually knows is that a Keychain is opaque.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";
import { createProviderProber, providerProcessEnv, signInOf, statusOf } from "../src/provider-instances";

/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
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
  // Their ids ARE the driver kinds, which is what makes an instance id usable
  // as a URL path segment and as a settings anchor.
  expect(instances.map((instance) => instance.id)).toEqual(["claude", "codex", "opencode"]);
  expect(instances.filter((instance) => instance.enabled).map((instance) => instance.id)).toEqual(["claude", "codex"]);
  // No config dir on the base login, and for Claude that is load-bearing:
  // setting CLAUDE_CONFIG_DIR even to ~/.claude reaches a different, empty
  // Keychain entry.
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
  // The one read that resolves them is the one the worker claim uses.
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
  // Exactly what `listProviderInstances` handed the page, returned unchanged —
  // which is what a settings form does when the user edited some OTHER field.
  engine.saveProviderInstance({
    id: "claude_work",
    displayName: "Work",
    env: [{ name: "SECRET_TOKEN", value: "", sensitive: true, valueRedacted: true }],
  });
  expect(engine.resolveProviderInstance("claude_work", "claude").env[0]?.value).toBe("sk-live-1234");

  // A non-empty value replaces it; dropping the variable forgets it.
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

test("an instance cannot change driver, and the built-in slot cannot be deleted", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "claude_work", driver: "claude" });
  // A session's resume cursor and its whole transcript belong to one harness.
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
  // Naming an instance names the driver: they are not chosen independently.
  expect(session).toMatchObject({ driver: "codex", providerInstanceId: "codex_work" });

  engine.removeProviderInstance("codex_work");
  // The conversation is still resumable. A settings change is not a reason for
  // a session to stop working — it drops back to the driver's built-in slot,
  // which is the same path a session created before this registry takes.
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
  // The worker is the process that spawns the provider; handing it the redacted
  // shape would launch the provider without the credential and fail confusingly.
  expect(claim?.providerInstance?.env).toEqual([{ name: "SECRET_TOKEN", value: "sk-live-1234", sensitive: true }]);
});

// ── the environment a provider process actually runs with ──────────────────

test("the built-in slot scrubs nothing; a configured instance scrubs what it owns", () => {
  const at = 100;
  const base = { id: "claude", driver: "claude" as const, enabled: true, env: [], createdAt: at, updatedAt: at };
  // The base login represents `claude` as the user launches it in a terminal:
  // it declares nothing, so it must load the provider's own user settings.
  expect(providerProcessEnv(base)).toEqual({});

  const work = { ...base, id: "claude_work", configDir: "~/.claude-work" };
  const patch = providerProcessEnv(work);
  // An inherited ANTHROPIC_API_KEY silently moves a subscription account onto
  // metered billing, so a configured instance stops inheriting one.
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

// ── the probe ──────────────────────────────────────────────────────────────

test("sign-in is read from the filesystem, and never asserts more than it knows", () => {
  const dir = root();
  // A Claude folder with no file credentials is UNKNOWN, not signed-out: the
  // token is in the Keychain, and calling it signed-out would be a confident
  // wrong answer about somebody's working account.
  expect(signInOf({ driver: "claude", configDir: dir }).signIn).toBe("unknown");
  // Codex credentials really are a file, so its absence IS definitive.
  expect(signInOf({ driver: "codex", configDir: dir }).signIn).toBe("signed-out");
  fs.writeFileSync(path.join(dir, "auth.json"), "{}");
  expect(signInOf({ driver: "codex", configDir: dir }).signIn).toBe("signed-in");
  expect(signInOf({ driver: "codex", configDir: path.join(dir, "nope") }).signIn).toBe("missing-config-dir");
  // No config dir at all is the base login: nothing on disk to inspect.
  expect(signInOf({ driver: "claude" }).signIn).toBe("unknown");
});

test("disabled outranks every other status", () => {
  // Painting a switched-off instance red sends people to fix something they
  // had already decided not to use.
  expect(statusOf({ enabled: false, installed: false, signIn: "missing-config-dir" })).toBe("disabled");
  expect(statusOf({ enabled: true, installed: false, signIn: "signed-in" })).toBe("error");
  expect(statusOf({ enabled: true, installed: true, signIn: "signed-out" })).toBe("warning");
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown" })).toBe("ready");
});

test("a CLI that is installed AND unusable is an error, not a green tick", () => {
  /**
   * `installed` alone answers "is there a binary", which is not the question the
   * pane is really asking. A Claude Code whose control protocol this build does
   * not speak (`cli-resolution.ts` → `incompatible`) is present, reports a
   * version, and refuses every turn submitted to it. Reported `ready`, the pane
   * would be the only place that looked fine.
   */
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown", usable: false })).toBe("error");
  // Absent means "the resolver had no opinion" — every existing caller — and
  // must not change the answer.
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown" })).toBe("ready");
  expect(statusOf({ enabled: true, installed: true, signIn: "unknown", usable: true })).toBe("ready");
  // Still outranked by the switch, like everything else.
  expect(statusOf({ enabled: false, installed: true, signIn: "unknown", usable: false })).toBe("disabled");
});

test("what the CLI resolution says outranks the sign-in note", async () => {
  /**
   * THE DRIFT WARNING EXISTED AND WAS NEVER DISPLAYED. Every healthy Claude
   * instance carries the sign-in note "credentials live in the Keychain, so this
   * cannot be confirmed from disk" — a statement that nothing can be known.
   * While that won the tie, "this CLI is a protocol version this build was not
   * tested against; suspect it first if tool calls are cancelled" — the one
   * sentence worth acting on — was dropped on the floor.
   */
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
  // Two Claude instances run the same binary; only their config folders differ,
  // and that check is a stat.
  expect(calls).toEqual(["claude", "codex"]);
  expect(probes.map((probe) => probe.status)).toEqual(["ready", "ready", "error"]);
  expect(probes[0]).toMatchObject({ instanceId: "claude", version: "2.1.0", checkedAt: 500 });
  // A missing binary outranks a sign-in note: there is no point saying the
  // config folder looks fine when the CLI it configures is not installed.
  expect(probes[2]?.message).toBe("not found");
});

test("two logins on the same driver get separate probes when they pin separate binaries", async () => {
  /**
   * THE CACHE KEY THAT HAD TO CHANGE. It was per DRIVER, on the reasoning that
   * two instances of one driver run the same binary and only their config
   * folders differ. `binaryPath` ended that, and the failure would have been
   * silent in the worst way: the second login reporting the first one's
   * version — a real number, about an executable that login never runs.
   */
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
  // One subprocess for the two that share the default, one for the pinned one.
  expect(asked).toEqual([undefined, "/opt/beta/claude"]);
  expect(probes.map((probe) => probe.version)).toEqual(["2.1.232", "2.1.232", "2.2.0"]);
});
