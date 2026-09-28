import { afterEach, expect, test } from "bun:test";
import {
  cliUpdateFor,
  compareVersions,
  forgetLatestVersions,
  runCliUpdate,
  updatePlanFor,
  updateStatusFor,
  type Registry,
} from "./cli-updates";
import type { CliResolution } from "./cli";
import type { ProviderUpdateRun } from "@telar/engine-client";

afterEach(() => forgetLatestVersions());

const home = "/users/somebody";

test("the native installers are recognised by the link OR its target", () => {
  expect(updatePlanFor("claude", { path: `${home}/.local/bin/claude` })?.method).toBe("native");
  expect(updatePlanFor("claude", { path: "/somewhere/odd/claude", realPath: `${home}/.local/share/claude/versions/2.1.229` })?.method).toBe(
    "native",
  );
  expect(updatePlanFor("codex", { path: `${home}/.local/bin/codex` })?.method).toBe("native");
  expect(updatePlanFor("codex", { path: "/somewhere/odd/codex", realPath: `${home}/.codex/packages/standalone/current/bin/codex` })?.method).toBe(
    "native",
  );
});

test("a native update runs the CLI's own updater, by the path it was resolved at", () => {
  expect(updatePlanFor("claude", { path: `${home}/.local/bin/claude` })?.command).toBe(`${home}/.local/bin/claude update`);
  expect(updatePlanFor("codex", { path: `${home}/.local/bin/codex` })?.command).toBe(`${home}/.local/bin/codex update`);
  expect(updatePlanFor("claude", { path: `${home}/.local/bin/claude` })?.executable).toBe(`${home}/.local/bin/claude`);
});

test("an npm global is found through its symlink, not by the bin directory it sits in", () => {
  const plan = updatePlanFor("claude", {
    path: "/usr/local/bin/claude",
    realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  });
  expect(plan?.method).toBe("npm");
  expect(plan?.command).toBe("npm install -g @anthropic-ai/claude-code@latest");
  expect(updatePlanFor("claude", { path: "/usr/local/bin/claude" })?.method).toBe("homebrew");
});

test("the other global managers each get their own command", () => {
  expect(updatePlanFor("codex", { path: `${home}/.bun/bin/codex` })?.command).toBe("bun i -g @openai/codex@latest");
  expect(updatePlanFor("codex", { path: `${home}/.local/share/pnpm/codex` })?.command).toBe("pnpm add -g @openai/codex@latest");
  expect(updatePlanFor("codex", { path: `${home}/.vite-plus/bin/codex` })?.command).toBe("vp i -g @openai/codex");
});

test("Homebrew is upgraded as the cask it actually is", () => {
  expect(updatePlanFor("claude", { path: "/opt/homebrew/Caskroom/claude-code/2.1.223/claude" })?.command).toBe(
    "brew upgrade --cask claude-code",
  );
  expect(updatePlanFor("codex", { path: "/opt/homebrew/bin/codex" })?.command).toBe("brew upgrade --cask codex");
});

test("an unrecognised path yields NO plan rather than a guess", () => {
  expect(updatePlanFor("claude", { path: "/opt/mine/bin/claude" })).toBeUndefined();
  expect(updatePlanFor("claude", {})).toBeUndefined();
});

test("versions compare on their numbers, and a prerelease sits below its release", () => {
  expect(compareVersions("2.1.229", "2.1.232")).toBe(-1);
  expect(compareVersions("2.1.232", "2.1.229")).toBe(1);
  expect(compareVersions("2.1.229", "2.1.229")).toBe(0);
  expect(compareVersions("2.1", "2.1.0")).toBe(0);
  expect(compareVersions("v0.147.0", "0.145.0")).toBe(1);
  expect(compareVersions("2.2.0-beta.1", "2.2.0")).toBe(-1);
  expect(compareVersions("2.2.0", "2.2.0-beta.1")).toBe(1);
});

test("the pairing outranks the registry", () => {
  expect(updateStatusFor({ installed: "2.1.224", latest: "2.1.232", expected: "2.1.224" })).toBe("pinned");
  expect(updateStatusFor({ installed: "2.1.180", latest: "2.1.232", expected: "2.1.224" })).toBe("behind");
  expect(updateStatusFor({ installed: "0.145.0", latest: "0.147.0" })).toBe("behind");
  expect(updateStatusFor({ installed: "2.1.232", latest: "2.1.232", expected: "2.1.224" })).toBe("current");
  expect(updateStatusFor({ installed: "2.2.0", latest: "2.1.232" })).toBe("current");
});

test("nothing to compare says nothing, rather than 'up to date'", () => {
  expect(updateStatusFor({ installed: "2.1.229" })).toBe("unknown");
  expect(updateStatusFor({ latest: "2.1.232" })).toBe("unknown");
  expect(updateStatusFor({})).toBe("unknown");
});

const resolution = (over: Partial<CliResolution> = {}): CliResolution => ({
  id: "claude",
  label: "Claude Code",
  status: "ok",
  path: `${home}/.local/bin/claude`,
  version: "2.1.229",
  ...over,
});

const registries: Registry[] = [];
const latest = (version: string | null) => async (registry: Registry) => {
  registries.push(registry);
  return version;
};

afterEach(() => registries.splice(0));

test("a Homebrew install is compared against Homebrew, and everything else against npm", async () => {
  await cliUpdateFor(resolution({ path: "/opt/homebrew/Caskroom/claude-code/2.1.223/claude" }), { latest: latest("2.1.223") });
  expect(registries[0]).toEqual({ kind: "homebrew", cask: "claude-code" });

  await cliUpdateFor(resolution(), { latest: latest("2.1.232") });
  expect(registries[1]).toEqual({ kind: "npm", name: "@anthropic-ai/claude-code" });
});

test("a behind install carries the command; a pinned one deliberately does not", async () => {
  const behind = await cliUpdateFor(resolution({ version: "2.1.180", expected: "2.1.224" }), { latest: latest("2.1.232") });
  expect(behind).toMatchObject({ status: "behind", latest: "2.1.232", method: "native" });
  expect(behind.command).toBe(`${home}/.local/bin/claude update`);

  const pinned = await cliUpdateFor(resolution({ version: "2.1.224", expected: "2.1.224" }), { latest: latest("2.1.232") });
  expect(pinned).toMatchObject({ status: "pinned", latest: "2.1.232" });
  expect(pinned.command).toBeUndefined();
});

test("a registry that will not answer leaves the row silent, not wrong", async () => {
  const quiet = await cliUpdateFor(resolution(), { latest: latest(null) });
  expect(quiet.status).toBe("unknown");
  expect(quiet.latest).toBeUndefined();
  expect(quiet.method).toBe("native");
});

test("a CLI with no version costs no request at all", async () => {
  const answer = await cliUpdateFor(resolution({ status: "unknown", version: undefined }), { latest: latest("2.1.232") });
  expect(answer.status).toBe("unknown");
  expect(registries).toEqual([]);
});

test("TELAR_NO_UPDATE_CHECKS switches off the network half and nothing else", async () => {
  process.env.TELAR_NO_UPDATE_CHECKS = "1";
  try {
    const answer = await cliUpdateFor(resolution(), { latest: latest("2.1.232") });
    expect(registries).toEqual([]);
    expect(answer.status).toBe("unknown");
    expect(answer.method).toBe("native");
  } finally {
    delete process.env.TELAR_NO_UPDATE_CHECKS;
  }
});

test("the registry is asked once an hour, and once more when a human asks", async () => {
  const clock = { at: 0 };
  const now = () => clock.at;
  const ask = () => cliUpdateFor(resolution(), { latest: latest("2.1.232"), now });

  await ask();
  await ask();
  expect(registries).toHaveLength(1);

  await cliUpdateFor(resolution(), { latest: latest("2.1.232"), now, force: true });
  expect(registries).toHaveLength(2);

  clock.at = 61 * 60 * 1_000;
  await ask();
  expect(registries).toHaveLength(3);
});

const ranOk = (): ProviderUpdateRun => ({ ok: true, command: "x", timedOut: false, message: "Updated." });

const runDeps = (over: { resolution?: Partial<CliResolution>; latest?: string | null; spawn?: () => Promise<ProviderUpdateRun> } = {}) => ({
  resolve: async () => resolution(over.resolution ?? {}),
  latest: latest(over.latest === undefined ? "2.1.232" : over.latest),
  spawn: over.spawn ?? (async () => ranOk()),
});

test("a pinned CLI is refused at the route, not merely hidden at the button", async () => {
  const refusal = runCliUpdate("claude", runDeps({ resolution: { version: "2.1.224", expected: "2.1.224" } }));
  await expect(refusal).rejects.toThrow(/pairs with/);
});

test("an install nobody recognises is refused with the sentence a person needs", async () => {
  const refusal = runCliUpdate("claude", runDeps({ resolution: { path: "/opt/mine/bin/claude" } }));
  await expect(refusal).rejects.toThrow(/how Claude Code was installed/);
});

test("a CLI that is not installed is refused with its own install message", async () => {
  const refusal = runCliUpdate(
    "claude",
    runDeps({ resolution: { status: "missing", path: undefined, version: undefined, message: "No Claude Code installation found." } }),
  );
  await expect(refusal).rejects.toThrow(/No Claude Code installation found/);
});

test("a second press while one is running is refused, and updates sharing a manager queue", async () => {
  const order: string[] = [];
  const gate: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => (gate.release = resolve));

  const claude = runCliUpdate("claude", {
    resolve: async () => resolution({ path: "/usr/local/bin/claude", realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js" }),
    latest: latest("2.1.232"),
    spawn: async () => {
      order.push("claude:start");
      await held;
      order.push("claude:done");
      return ranOk();
    },
  });

  await expect(
    runCliUpdate("claude", {
      resolve: async () => resolution({ path: "/usr/local/bin/claude", realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js" }),
      latest: latest("2.1.232"),
      spawn: async () => ranOk(),
    }),
  ).rejects.toThrow(/already running/);

  const codex = runCliUpdate("codex", {
    resolve: async () =>
      resolution({ id: "codex", label: "Codex", path: "/usr/local/bin/codex", realPath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" }),
    latest: latest("0.147.0"),
    spawn: async () => {
      order.push("codex:start");
      return ranOk();
    },
  });

  gate.release!();
  await Promise.all([claude, codex]);
  expect(order).toEqual(["claude:start", "claude:done", "codex:start"]);
});
