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
import { resolveChildEnv } from "../src/claude-identity";

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
  // OpenCode alone is off out of the box. (`telar` was a fourth slot until #531
  // removed the driver with it — the engine's own loop is the built-in Agent
  // now, and no session runs on it.)
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

// ── what becoming configured costs, said out loud (#594) ───────────────────
//
// The scrub above is right and is not what these pin. What they pin is that it
// stops being SILENT: one variable — including one written by the compaction
// control, which is somebody thinking about compaction and nothing else — makes
// an instance configured and drops everything its driver owns out of the child.

/** An engine launched from a terminal that had a proxy and a routing switch
 *  set: the situation the issue is about. The values are synthetic; the two
 *  that carry information are distinctive so the leak check below can look for
 *  them by substring. */
const PROXIED = {
  PATH: "/usr/bin",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_AUTH_TOKEN: "sk-ant-not-a-real-token",
} as const;

/** A Mac launched from the Dock, which is every user who has not gone out of
 *  their way: none of the fourteen names is here. */
const DOCK = { PATH: "/usr/bin" } as const;

const storeWith = (ambient: Record<string, string | undefined>): EngineStore =>
  new EngineStore(root(), () => 100, { ambientEnv: ambient });

/** The environment the child process ACTUALLY gets — the patch merged over the
 *  engine's own, exactly as `driver.ts` does it. Asserting on the patch alone
 *  would be asserting on an intention. */
const childEnv = (engine: EngineStore, id: string, driver: "claude" | "codex" | "opencode", ambient: Record<string, string | undefined>) =>
  resolveChildEnv(ambient, providerProcessEnv(engine.resolveProviderInstance(id, driver)))!;

test("a login gaining its first variable reports what it stops inheriting, by name", () => {
  const engine = storeWith(PROXIED);
  // The compaction control's own write and nothing else — one variable, about
  // something unrelated to identity.
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });

  expect(saved.stoppedInheriting).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]);
  // And it is what actually happened: the child really has lost them.
  expect(childEnv(engine, "claude", "claude", PROXIED)).toEqual({ PATH: "/usr/bin", DISABLE_AUTO_COMPACT: "1" });

  // NAMES, NEVER VALUES. Three of the fourteen are credentials, so a report
  // that showed what was about to be lost would be the leak this exists to
  // prevent. Checked against the WHOLE serialised answer rather than the array
  // alone, because a value smuggled into a message would pass a check on the
  // array — and against the two ambient values that carry information, since a
  // bare `1` would collide with the variable the caller itself just sent.
  const answer = JSON.stringify(saved);
  expect(answer).not.toContain(PROXIED.ANTHROPIC_AUTH_TOKEN);
  expect(answer).not.toContain(PROXIED.ANTHROPIC_BASE_URL);
  // And the report is a list of NAMES: nothing in it is a value at all.
  expect(saved.stoppedInheriting.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))).toBe(true);
  // The save stored exactly what was submitted — nothing was quietly folded in.
  expect(saved.instance.env).toEqual([{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }]);
});

test("with a clean environment there is nothing to report", () => {
  const engine = storeWith(DOCK);
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });
  // A Dock-launched Mac inherits none of them, so nothing is lost and nothing
  // is said. A warning nobody can act on is one nobody reads.
  expect(saved.stoppedInheriting).toEqual([]);
});

test("carrying a variable over declares it, and the child keeps the value it had", () => {
  const engine = storeWith(PROXIED);
  const before = childEnv(engine, "claude", "claude", PROXIED);
  expect(before.ANTHROPIC_BASE_URL).toBe(PROXIED.ANTHROPIC_BASE_URL);

  engine.saveProviderInstance({ id: "claude", env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }] });
  const carried = engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_BASE_URL"] });

  // The declaration is applied AFTER the scrub, so it survives it — which is
  // the mechanism the issue identified and the reason this remedy works.
  const after = childEnv(engine, "claude", "claude", PROXIED);
  expect(after.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
  expect(after.DISABLE_AUTO_COMPACT).toBe("1");
  // Still scrubbed, because they were not carried: only what was asked for came
  // back.
  expect("CLAUDE_CODE_USE_BEDROCK" in after).toBe(false);
  // Carrying it over in the same breath means nothing was lost by that save.
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
  // It stopped inheriting them on the FIRST variable. Saying so again would be
  // announcing a change that did not happen, and is how a warning becomes
  // wallpaper.
  expect(second.stoppedInheriting).toEqual([]);
});

test("a config folder is a transition too, and the folder's own variable is not a loss", () => {
  const engine = storeWith(PROXIED);
  const saved = engine.saveProviderInstance({ id: "claude_work", driver: "claude", configDir: "~/.claude-work" });
  // CLAUDE_CONFIG_DIR is inherited here as well — but this save REPLACES it
  // with the folder that was just named, which is the entire point of naming
  // one. Reporting it would send somebody to fix something that is working.
  expect(saved.stoppedInheriting).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]);
});

test("a variable the same save declares is not reported as lost", () => {
  const engine = storeWith(PROXIED);
  const saved = engine.saveProviderInstance({
    id: "claude_proxy",
    driver: "claude",
    env: [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", sensitive: false }],
  });
  // Declared beats inherited and survives the scrub, so this login is not
  // losing that variable — it is choosing its own.
  expect(saved.stoppedInheriting).not.toContain("ANTHROPIC_BASE_URL");
  expect(childEnv(engine, "claude_proxy", "claude", PROXIED).ANTHROPIC_BASE_URL).toBe("https://proxy.example");
});

test("a carried-over credential is stored as a secret and does not come back", () => {
  const engine = storeWith(PROXIED);
  engine.saveProviderInstance({ id: "claude", env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }] });
  engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_AUTH_TOKEN"] });

  const listed = engine.listProviderInstances().find((instance) => instance.id === "claude")!;
  // The settings page reads this. A token carried over in the user's interest
  // must not be echoed back to whoever opens the pane.
  expect(listed.env).toContainEqual({ name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true });
  expect(JSON.stringify(listed)).not.toContain(PROXIED.ANTHROPIC_AUTH_TOKEN);
  // And the child still gets it, which is the whole point of carrying it.
  expect(childEnv(engine, "claude", "claude", PROXIED).ANTHROPIC_AUTH_TOKEN).toBe(PROXIED.ANTHROPIC_AUTH_TOKEN);
});

test("a carry-over that would have to guess is refused rather than guessed", () => {
  const engine = storeWith(PROXIED);
  // Not a variable this driver owns: a declaration would protect it from a
  // scrub that never touches it.
  expect(() => engine.saveProviderInstance({ id: "claude", carryOverInherited: ["OPENAI_API_KEY"] })).toThrow(/claude login owns/);
  // Not being inherited: writing it would store an EMPTY value, which is a
  // variable the CLI reads rather than the absence that was asked for.
  expect(() => engine.saveProviderInstance({ id: "claude", carryOverInherited: ["ANTHROPIC_API_KEY"] })).toThrow(/not inheriting/);
  // Already declared by this save: the caller has lost track of its own request.
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
  // `ANTHROPIC_BASE_URL=` reaches a child as a variable the CLI reads as unset,
  // so losing it loses nothing — and there would be nothing to carry over.
  const engine = storeWith({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "   " });
  const saved = engine.saveProviderInstance({
    id: "claude",
    env: [{ name: "DISABLE_AUTO_COMPACT", value: "1", sensitive: false }],
  });
  expect(saved.stoppedInheriting).toEqual([]);
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

/**
 * ── UPGRADING PAST A RETIRED DRIVER — issue #531 ────────────────────────────
 *
 * `telar` was a driver kind for one day (#526). Every store that ran that build
 * has a row naming it, and the registry read has to survive meeting one.
 *
 * The bug these pin: the read strict-parsed the whole array, so one stale row
 * threw out of THE read behind every provider lookup. The settings page 400'd
 * with `invalid provider instance registry`, and because `resolveProviderInstance`
 * sits on the session claim, starting a session failed the same way — which is
 * what "the engine isn't responding" looked like from the cockpit.
 */

/** A store whose registry was written by the #526 build, key and all. */
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

  // The whole point: no throw, and the three live logins come back.
  expect(engine.listProviderInstances().map((instance) => instance.id)).toEqual(["claude", "codex", "opencode"]);
  // Written back once, so the next read is not a second repair.
  const onDisk = JSON.parse(fs.readFileSync(path.join(directory, "provider-instances.json"), "utf8"));
  expect(onDisk.providerInstances.map((instance: { id: string }) => instance.id)).toEqual(["claude", "codex", "opencode"]);
});

test("the read drops the retired row but will not touch the key the carry still needs", () => {
  /**
   * THE ORDERING HAZARD, PINNED. `readProviderInstances` runs from anywhere —
   * a worker, a route, a test — and can easily beat the daemon's startup sweep.
   * If it deleted secrets the way `removeProviderInstance` does, whether the
   * upgrade kept somebody's key would depend on which read happened to land
   * first. So the lazy path takes the row and leaves the credential.
   */
  const directory = root();
  upgradedFrom526(directory);
  const engine = new EngineStore(directory, () => 100);

  engine.listProviderInstances();
  const secrets = JSON.parse(fs.readFileSync(path.join(directory, "provider-secrets.json"), "utf8"));
  expect(secrets.secrets["telar OPENCODE_API_KEY"]).toBe("sk-from-526");
  // And the carry, running afterwards, still finds it.
  expect(engine.carryOverAgentKey()).toBe(true);
  expect(engine.agentCredential().set).toBe(true);
});

test("the sweep drops the orphaned secret only after the carry has read it", () => {
  const directory = root();
  upgradedFrom526(directory);
  const engine = new EngineStore(directory, () => 100);

  // The daemon's order: carry, then drop.
  expect(engine.carryOverAgentKey()).toBe(true);
  expect(engine.removeRetiredProviderSecrets()).toBe(true);

  const secrets = JSON.parse(fs.readFileSync(path.join(directory, "provider-secrets.json"), "utf8"));
  expect(secrets.secrets["telar OPENCODE_API_KEY"]).toBeUndefined();
  // The key survived the drop, in its new home.
  expect(engine.agentCredential().set).toBe(true);
  // Idempotent: a second start has nothing left to say.
  expect(engine.removeRetiredProviderSecrets()).toBe(false);
});

test("a live login's secrets are never mistaken for an orphan", () => {
  const engine = store();
  engine.saveProviderInstance({
    id: "claude_work",
    driver: "claude",
    env: [{ name: "ANTHROPIC_API_KEY", value: "sk-live", sensitive: true }],
  });
  expect(engine.removeRetiredProviderSecrets()).toBe(false);
  expect(engine.resolveProviderInstance("claude_work", "claude").env[0]?.value).toBe("sk-live");
});

test("a malformed row is still corruption, and still refuses to read", () => {
  /**
   * THE PRUNE STAYS NARROW. Forgiving an unknown `driver` is a migration;
   * forgiving anything else would let a login somebody configured disappear
   * because one field got mangled, which is the worse failure of the two.
   */
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

test("a secret key the registry could not have minted is left alone", () => {
  /**
   * `indexOf` returns -1 for a key with no separator, and `slice(0, -1)` would
   * hand the live-id set a prefix that never matches — a silent delete wearing
   * a lookup's clothes. Same judgement as a malformed row: not this sweep's.
   */
  const directory = root();
  fs.writeFileSync(
    path.join(directory, "provider-secrets.json"),
    JSON.stringify({ version: 2, secrets: { NOSEPARATOR: "keep-me" } }),
  );
  const engine = new EngineStore(directory, () => 100);
  expect(engine.removeRetiredProviderSecrets()).toBe(false);
  const secrets = JSON.parse(fs.readFileSync(path.join(directory, "provider-secrets.json"), "utf8"));
  expect(secrets.secrets.NOSEPARATOR).toBe("keep-me");
});
