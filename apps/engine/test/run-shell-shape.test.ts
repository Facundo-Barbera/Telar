/**
 * WHAT A RECIPE SAYS ABOUT WHO RUNS IT — and what it deliberately does NOT say.
 *
 * The rule being served is that nothing downstream should have to guess who
 * splits a command line. The way it is served is NOT a stored argv: splitting
 * `a && b` into words destroys it. The recipe keeps the string a human typed
 * and names the program that is handed it, so the spawn is
 * `spawn(file, [...prefix, command])` with no shell flag — nothing splits and
 * nothing guesses, while `a && b` still means `a && b`.
 *
 * THE WIN32 CASES ARE ASSERTED FROM A MAC, which is why `resolveShell` takes a
 * platform rather than reading one. What they prove is that Telar asks
 * `cmd.exe` for the right thing; they cannot and do not claim `cmd.exe` obeys.
 *
 * Every run here is a `sh` command in a `mkdtemp` worktree that exits on its
 * own, and every store is a temp directory that does not survive this file.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { resolveShell } from "../src/run/shell";
import { RunStore } from "../src/run/store";
import { redactConfiguration, type RunConfiguration } from "../src/run/types";

const managers: RunManager[] = [];
const tempDirs: string[] = [];

const track = (dir: string): string => (tempDirs.push(dir), dir);
const worktree = () => track(fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-shape-tree-")));
const storeDir = () => track(fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-shape-store-")));

function runManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(command: string, extra: Partial<RunConfiguration> = {}): RunConfiguration {
  return { id: "runcfg_test", projectId: "proj_1", name: "fixture", command, createdAt: 1, updatedAt: 1, ...extra };
}

function input(tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput {
  return { projectId: "proj_1", config: cfg, worktreePath: tree, sessionId: "sess_a", ...extra };
}

/** Matches this file's own ceiling; see `run-manager.test.ts` for why. */
async function until(predicate: () => boolean, ms = 6_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

// ── which shell, and where the command sits in its argv ────────────────────

test("a recipe with no shell resolves to this platform's own, with the command last and nothing split", () => {
  const posix = resolveShell(config("bun run dev && echo done"), "darwin", {});
  expect(posix.file).toBe("/bin/sh");
  // The `&&` survives because a shell still evaluates it — it is ONE argument,
  // not two words a caller had to know how to separate.
  expect(posix.args).toEqual(["-c", "bun run dev && echo done"]);
  expect(posix.args.at(-1)).toBe("bun run dev && echo done");
  expect(posix.windowsVerbatimArguments).toBe(false);
});

test("on win32 the command goes to ComSpec, quoted the way cmd.exe expects and verbatim so node does not quote it twice", () => {
  const spec = resolveShell(config("bun run dev && echo done"), "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  expect(spec.file).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(spec.args).toEqual(["/d", "/s", "/c", '"bun run dev && echo done"']);
  expect(spec.windowsVerbatimArguments).toBe(true);
});

test("win32 without a ComSpec still names a program rather than leaving one to be guessed", () => {
  expect(resolveShell(config("bun run dev"), "win32", {}).file).toBe("cmd.exe");
});

test("a win32 ComSpec that is not cmd gets -c and no cmd quoting", () => {
  const spec = resolveShell(config("bun run dev"), "win32", { ComSpec: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
  expect(spec.args).toEqual(["-c", "bun run dev"]);
  expect(spec.windowsVerbatimArguments).toBe(false);
});

test("a pinned shell is taken literally on every platform: its argv, then the command, and no quoting added", () => {
  const pinned = config("a && b", { shell: { program: "/bin/bash", args: ["-l", "-c"] } });
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const spec = resolveShell(pinned, platform, { ComSpec: "cmd.exe" });
    expect(spec.file).toBe("/bin/bash");
    expect(spec.args).toEqual(["-l", "-c", "a && b"]);
    expect(spec.windowsVerbatimArguments).toBe(false);
  }
});

test("a pinned shell with no args still puts the command last", () => {
  expect(resolveShell(config("app.exe", { shell: { program: "runner" } }), "win32", {}).args).toEqual(["app.exe"]);
});

test("a pinned shell is what actually gets spawned, not merely what is stored", async () => {
  const manager = runManager();
  /**
   * `/bin/echo` IS THE POINT, and a shell would not do. If the pin were
   * ignored and the default `/bin/sh -c` used instead, the command below is
   * not a program and the run would fail with `not found` — so this line can
   * only be produced by the stored program having been spawned with the stored
   * argv and the command appended to it.
   */
  const pinned = config("the-command-as-an-argument", { shell: { program: "/bin/echo", args: ["ran-the-pinned-program"] } });
  const run = await manager.start(input(worktree(), pinned));
  expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
  expect(manager.output(run.runId).lines.map((line) => line.text)).toEqual(["ran-the-pinned-program the-command-as-an-argument"]);
}, 15_000);

// ── the migration ──────────────────────────────────────────────────────────

test("a recipe saved before shells were stored still reads, and still runs, with nothing rewritten", async () => {
  const dir = storeDir();
  const old = {
    configurations: [
      { id: "runcfg_old", projectId: "proj_1", name: "web dev", command: "echo legacy && echo ok", createdAt: 1, updatedAt: 1 },
    ],
  };
  fs.writeFileSync(path.join(dir, "proj_1.json"), JSON.stringify(old));

  const stored = new RunStore(dir).get("proj_1", "runcfg_old");
  expect(stored.shell).toBeUndefined();
  expect(resolveShell(stored, "darwin", {}).args).toEqual(["-c", "echo legacy && echo ok"]);

  const manager = runManager();
  const run = await manager.start(input(worktree(), stored));
  expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
  const output = manager.output(run.runId).lines.map((line) => line.text);
  // `&&` still means `&&`: the recipe was never split into words.
  expect(output).toContain("legacy");
  expect(output).toContain("ok");

  // Reading it did not rewrite the document — an unpinned recipe stays
  // unpinned, because a resolved `/bin/sh` on disk is this Mac leaking into a
  // file that has to open elsewhere.
  expect(JSON.parse(fs.readFileSync(path.join(dir, "proj_1.json"), "utf8"))).toEqual(old);
}, 15_000);

test("a pinned shell round-trips through the store, and a patch that does not mention it leaves it alone", () => {
  const dir = storeDir();
  const store = new RunStore(dir);
  const created = store.create("proj_1", { name: "web dev", command: "bun run dev", shell: { program: "/bin/bash", args: ["-lc"] } });
  expect(created.shell).toEqual({ program: "/bin/bash", args: ["-lc"] });
  expect(new RunStore(dir).get("proj_1", created.id).shell).toEqual({ program: "/bin/bash", args: ["-lc"] });

  // This is what the config editor sends: it has no shell field, so the shallow
  // merge must not read its absence as "clear it".
  const updated = store.update("proj_1", created.id, { name: "web dev", command: "bun run start", cwd: "apps/web" });
  expect(updated.shell).toEqual({ program: "/bin/bash", args: ["-lc"] });
  expect(updated.command).toBe("bun run start");
});

test("a shell is not a hole in the redaction promise — a secret pasted into one is scrubbed like every other field", () => {
  const view = redactConfiguration(
    config("bun run dev", {
      shell: { program: "/opt/sk_live_abcdef/bash", args: ["-c", "--token=sk_live_abcdef"] },
      env: [{ key: "TOKEN", value: "sk_live_abcdef", secret: true }],
    }),
  );
  expect(view.shell).toEqual({ program: "/opt/«redacted»/bash", args: ["-c", "--token=«redacted»"] });
  expect(JSON.stringify(view)).not.toContain("sk_live_abcdef");
});

test("a store refuses a shell with no program rather than saving a recipe nothing can launch", () => {
  const store = new RunStore(storeDir());
  expect(() => store.create("proj_1", { name: "web", command: "bun run dev", shell: { program: "" } })).toThrow();
});
