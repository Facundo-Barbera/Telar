/**
 * WHETHER A NEWER CLI EXISTS, AND WHAT TELAR IS WILLING TO DO ABOUT IT.
 *
 * Two of these are here because getting them wrong is invisible rather than
 * loud: an install method inferred from the wrong half of a symlink offers a
 * `brew upgrade` for a cask that is not installed, and a `latest` taken from
 * the wrong registry tells a Homebrew user for ever that they are behind. Both
 * fail as a button that does nothing, which reads as Telar being broken rather
 * than Telar being wrong.
 */
import { afterEach, expect, test } from "bun:test";
import {
  cliUpdateFor,
  compareVersions,
  forgetLatestVersions,
  runCliUpdate,
  updatePlanFor,
  updateStatusFor,
  type CliUpdateRun,
  type Registry,
} from "../src/cli-updates";
import type { CliResolution } from "../src/cli-resolution";

afterEach(() => forgetLatestVersions());

const home = "/users/somebody";

// ── which installer put it there ───────────────────────────────────────────

test("the native installers are recognised by the link OR its target", () => {
  // What this machine actually looks like: ~/.local/bin/claude is a symlink
  // into ~/.local/share/claude/versions/2.1.229, and Codex's standalone
  // installer links ~/.local/bin/codex into ~/.codex/packages/standalone/.
  // Whichever half a caller happens to hold has to be enough.
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
  // BOTH CLIs HAVE ONE, which is where this leaves the donor behind: T3 Code
  // declares `nativeUpdate: null` for Codex, and `codex --help` lists
  // `update  Update Codex to the latest version`. Asking the binary beat
  // inheriting the claim.
  expect(updatePlanFor("claude", { path: `${home}/.local/bin/claude` })?.command).toBe(`${home}/.local/bin/claude update`);
  expect(updatePlanFor("codex", { path: `${home}/.local/bin/codex` })?.command).toBe(`${home}/.local/bin/codex update`);
  // Not the bare name — a packaged app cannot count on finding it on PATH, and
  // that is the entire reason cli-resolution.ts exists.
  expect(updatePlanFor("claude", { path: `${home}/.local/bin/claude` })?.executable).toBe(`${home}/.local/bin/claude`);
});

test("an npm global is found through its symlink, not by the bin directory it sits in", () => {
  /**
   * THE ORDERING BUG THIS PINS. npm's global prefix on an Intel Mac is
   * /usr/local/lib/node_modules, linked from /usr/local/bin — which is also one
   * of Homebrew's bare prefixes. Classify on the link alone and every
   * npm-installed CLI on that machine gets offered `brew upgrade` for a cask it
   * does not have. Following the symlink first is what stops it.
   */
  const plan = updatePlanFor("claude", {
    path: "/usr/local/bin/claude",
    realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  });
  expect(plan?.method).toBe("npm");
  expect(plan?.command).toBe("npm install -g @anthropic-ai/claude-code@latest");
  // And with nothing to follow, /usr/local/bin really is Homebrew's.
  expect(updatePlanFor("claude", { path: "/usr/local/bin/claude" })?.method).toBe("homebrew");
});

test("the other global managers each get their own command", () => {
  expect(updatePlanFor("codex", { path: `${home}/.bun/bin/codex` })?.command).toBe("bun i -g @openai/codex@latest");
  expect(updatePlanFor("codex", { path: `${home}/.local/share/pnpm/codex` })?.command).toBe("pnpm add -g @openai/codex@latest");
  expect(updatePlanFor("codex", { path: `${home}/.vite-plus/bin/codex` })?.command).toBe("vp i -g @openai/codex");
});

test("Homebrew is upgraded as the cask it actually is", () => {
  // `brew info --cask` on both: casks, not formulae. Saying which stops a
  // machine with a same-named formula being sent to the wrong one.
  expect(updatePlanFor("claude", { path: "/opt/homebrew/Caskroom/claude-code/2.1.223/claude" })?.command).toBe(
    "brew upgrade --cask claude-code",
  );
  expect(updatePlanFor("codex", { path: "/opt/homebrew/bin/codex" })?.command).toBe("brew upgrade --cask codex");
});

test("an unrecognised path yields NO plan rather than a guess", () => {
  /**
   * The donor falls back to "assume npm global". On a machine where somebody
   * built the CLI themselves, that button would silently replace their build
   * with a published one — a destructive answer to a question Telar cannot
   * actually answer.
   */
  expect(updatePlanFor("claude", { path: "/opt/mine/bin/claude" })).toBeUndefined();
  expect(updatePlanFor("claude", {})).toBeUndefined();
});

// ── comparing versions ─────────────────────────────────────────────────────

test("versions compare on their numbers, and a prerelease sits below its release", () => {
  expect(compareVersions("2.1.229", "2.1.232")).toBe(-1);
  expect(compareVersions("2.1.232", "2.1.229")).toBe(1);
  expect(compareVersions("2.1.229", "2.1.229")).toBe(0);
  // Ragged lengths, and a leading v from a tag-shaped string.
  expect(compareVersions("2.1", "2.1.0")).toBe(0);
  expect(compareVersions("v0.147.0", "0.145.0")).toBe(1);
  // The arm that would otherwise be actively wrong: a beta tester told for ever
  // that they are behind a version they have already passed.
  expect(compareVersions("2.2.0-beta.1", "2.2.0")).toBe(-1);
  expect(compareVersions("2.2.0", "2.2.0-beta.1")).toBe(1);
});

// ── the verdict ────────────────────────────────────────────────────────────

test("the pairing outranks the registry", () => {
  /**
   * THE ONE RULE THE DONOR CANNOT EXPRESS, because it pins no wrapper version.
   * An install sitting exactly on the version this build was tested against is
   * in the best state Telar can verify. Offering a one-click update there would
   * be Telar breaking its own pairing on its own advice — and the failure that
   * follows is not a clean error, it is tool calls cancelled by nobody.
   */
  expect(updateStatusFor({ installed: "2.1.224", latest: "2.1.232", expected: "2.1.224" })).toBe("pinned");
  // A version that is neither current nor the pairing is simply behind.
  expect(updateStatusFor({ installed: "2.1.180", latest: "2.1.232", expected: "2.1.224" })).toBe("behind");
  // No pairing at all — Codex has no wrapper to derive one from — never pins.
  expect(updateStatusFor({ installed: "0.145.0", latest: "0.147.0" })).toBe("behind");
  expect(updateStatusFor({ installed: "2.1.232", latest: "2.1.232", expected: "2.1.224" })).toBe("current");
  // Ahead of the registry is still current: a nightly is not "behind".
  expect(updateStatusFor({ installed: "2.2.0", latest: "2.1.232" })).toBe("current");
});

test("nothing to compare says nothing, rather than 'up to date'", () => {
  // Both halves matter: a registry that did not answer and a CLI that would not
  // report a version are the same silence, and neither is evidence of health.
  expect(updateStatusFor({ installed: "2.1.229" })).toBe("unknown");
  expect(updateStatusFor({ latest: "2.1.232" })).toBe("unknown");
  expect(updateStatusFor({})).toBe("unknown");
});

// ── the advisory the pane receives ─────────────────────────────────────────

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
  /**
   * THE DONOR ASKS NPM WHATEVER THE INSTALL METHOD, and the brew cask trails
   * npm — 2.1.223 against 2.1.232 while this was written. A Homebrew user would
   * be told an update exists, press the button, get the newest cask, and be told
   * again. For ever. The ceiling is whatever the registry you install FROM has.
   */
  await cliUpdateFor(resolution({ path: "/opt/homebrew/Caskroom/claude-code/2.1.223/claude" }), { latest: latest("2.1.223") });
  expect(registries[0]).toEqual({ kind: "homebrew", cask: "claude-code" });

  await cliUpdateFor(resolution(), { latest: latest("2.1.232") });
  expect(registries[1]).toEqual({ kind: "npm", name: "@anthropic-ai/claude-code" });
});

test("a behind install carries the command; a pinned one deliberately does not", async () => {
  const behind = await cliUpdateFor(resolution({ version: "2.1.180", expected: "2.1.224" }), { latest: latest("2.1.232") });
  expect(behind).toMatchObject({ status: "behind", latest: "2.1.232", method: "native" });
  expect(behind.command).toBe(`${home}/.local/bin/claude update`);

  // The newer version is still REPORTED — the choice belongs to the person —
  // but Telar does not hand over the thing that would break its own pairing.
  const pinned = await cliUpdateFor(resolution({ version: "2.1.224", expected: "2.1.224" }), { latest: latest("2.1.232") });
  expect(pinned).toMatchObject({ status: "pinned", latest: "2.1.232" });
  expect(pinned.command).toBeUndefined();
});

test("a registry that will not answer leaves the row silent, not wrong", async () => {
  const quiet = await cliUpdateFor(resolution(), { latest: latest(null) });
  expect(quiet.status).toBe("unknown");
  expect(quiet.latest).toBeUndefined();
  // The local facts survive the network's absence: how it was installed is
  // still known, and the settings page still loads.
  expect(quiet.method).toBe("native");
});

test("a CLI with no version costs no request at all", async () => {
  // `unknown` from the resolver means the binary would not report a version.
  // Asking a registry then spends a round trip to learn something unusable.
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
    // Still a local fact, still true, still worth having.
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

  // Re-check is a gesture, so it goes past the cache. A repaint never does.
  await cliUpdateFor(resolution(), { latest: latest("2.1.232"), now, force: true });
  expect(registries).toHaveLength(2);

  clock.at = 61 * 60 * 1_000;
  await ask();
  expect(registries).toHaveLength(3);
});

// ── running it ─────────────────────────────────────────────────────────────

const ranOk = (): CliUpdateRun => ({ ok: true, command: "x", timedOut: false, message: "Updated." });

const runDeps = (over: { resolution?: Partial<CliResolution>; latest?: string | null; spawn?: () => Promise<CliUpdateRun> } = {}) => ({
  resolve: async () => resolution(over.resolution ?? {}),
  latest: latest(over.latest === undefined ? "2.1.232" : over.latest),
  spawn: over.spawn ?? (async () => ranOk()),
});

test("a pinned CLI is refused at the route, not merely hidden at the button", async () => {
  /**
   * WITHOUT THIS, THE RULE IS DECORATION. The pane withholds the button because
   * the engine withheld the command — but the route is reachable by anything on
   * the tailnet, so the state that must not be updated has to say no here too.
   */
  const refusal = runCliUpdate("claude", runDeps({ resolution: { version: "2.1.224", expected: "2.1.224" } }));
  await expect(refusal).rejects.toThrow(/pairs with/);
});

test("an install nobody recognises is refused with the sentence a person needs", async () => {
  // Not "unknown error": what was found, and what to do about it instead.
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
  /**
   * TWO DIFFERENT PROBLEMS, ONE MECHANISM. Pressing the same button twice
   * should say "already running" rather than start a second installer over the
   * first. Two DIFFERENT CLIs installed by the same package manager must not
   * run concurrently either — parallel `npm install -g` runs interleave writes
   * into one global tree.
   */
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

  // The same CLI again, while the first is still in flight.
  await expect(
    runCliUpdate("claude", {
      resolve: async () => resolution({ path: "/usr/local/bin/claude", realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js" }),
      latest: latest("2.1.232"),
      spawn: async () => ranOk(),
    }),
  ).rejects.toThrow(/already running/);

  // A different CLI on the same manager waits its turn rather than overlapping.
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
