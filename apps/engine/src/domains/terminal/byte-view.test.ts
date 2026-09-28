import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunLaunchEvents, RunLauncher } from "./launcher";
import { RunManager } from "./manager";
import { type StartRunInput } from "./live-run";
import { escapeScan, PTY_MASK } from "./pty-stream";
import { matchRunRoute } from "./routes";
import { RunStore } from "./store";
import { storeRunCapability } from "./store-capability";
import type { RunConfiguration } from "./types";

const managers: RunManager[] = [];
const tempDirs: string[] = [];

const temp = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-bytes-${label}-`));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const config = (overrides: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_1",
  projectId: "proj_1",
  name: "dev",
  command: "sleep 60",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const input = (dir: string, overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  projectId: "proj_1",
  sessionId: "sess_1",
  config: config(),
  worktreePath: dir,
  ...overrides,
});

function fakePty() {
  const state = {
    events: undefined as RunLaunchEvents | undefined,
    wrote: [] as string[],
    resized: [] as Array<[number, number]>,
  };
  const launcher: RunLauncher = {
    kind: "pty",
    async launch(_request, events) {
      state.events = events;
      return {
        pid: 424242,
        terminalId: "term_fake",
        close: async () => state.events?.exited({ exitCode: 0, closed: "close" }),
        signal: async () => {},
        write: async (data: string) => {
          state.wrote.push(data);
          return true;
        },
        resize: async (cols: number, rows: number) => {
          state.resized.push([cols, rows]);
          return true;
        },
      };
    },
  };
  return { launcher, state };
}

function manage(launcher?: RunLauncher): RunManager {
  const manager = new RunManager({
    ...(launcher ? { launcher } : {}),
    kill: () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
    stopGraceMs: 50,
  });
  managers.push(manager);
  return manager;
}

async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("the ring holds the redactor's OUTPUT, so a screen keeps its columns and loses its secret", async () => {
  const secret = "sk-live-9f41c2b7";
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("mask"), { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }));

  const screen = `\x1b[2J\x1b[1;1Hkey=${secret}\x1b[2;1Hdone`;
  for (let at = 0; at < screen.length; at += 5) state.events!.output("stdout", screen.slice(at, at + 5));

  expect(await until(() => manager.bytes(started.runId).chunks.join("").includes("done"))).toBe(true);
  const drawn = manager.bytes(started.runId).chunks.join("");

  expect(drawn).toBe(`\x1b[2J\x1b[1;1Hkey=${PTY_MASK.repeat(secret.length)}\x1b[2;1Hdone`);
  expect(drawn).not.toContain(secret);
  expect(drawn).toHaveLength(screen.length);

  const lines = manager.output(started.runId).lines.map((line) => line.text).join("");
  expect(lines).not.toContain(secret);
});

test("every chunk the ring hands back is escape-whole, however the bytes were sliced", async () => {
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("escapes")));

  const text = `\x1b[31mred\x1b[0m plain \x1b]0;a title\x07tail`;
  for (const character of text) state.events!.output("stdout", character);

  expect(await until(() => manager.bytes(started.runId).chunks.join("").includes("tail"))).toBe(true);
  const { chunks } = manager.bytes(started.runId);
  expect(chunks.join("")).toBe(text);
  for (const chunk of chunks) expect(escapeScan(chunk).pending).toBe(-1);
});

test("the ring drops whole chunks, so what survives is never half a sequence", async () => {
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("evict")));

  const unit = "\x1b[31mx\x1b[0m";
  for (let index = 0; index < 4_200; index += 1) state.events!.output("stdout", unit);
  expect(await until(() => manager.bytes(started.runId).dropped > 0)).toBe(true);

  const { chunks, cursor, dropped } = manager.bytes(started.runId);
  const retained = chunks.join("");
  expect(retained).toBe(unit.repeat(chunks.length));
  expect(retained.startsWith("\x1b[31m")).toBe(true);
  expect(escapeScan(retained).pending).toBe(-1);

  expect(dropped).toBeGreaterThan(0);
  expect(cursor).toBe(dropped + chunks.length);
  expect(cursor).toBe(4_200);

  expect(manager.bytes(started.runId, 0).chunks.length).toBe(chunks.length);
});

test("a pipe-launched run still fills the byte view, interleaved and CRLF-terminated", async () => {
  const manager = manage();
  const started = await manager.start(
    input(temp("pipes"), { config: config({ command: "printf 'one\\n'; printf 'two\\n' 1>&2" }) }),
  );
  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);

  const drawn = manager.bytes(started.runId).chunks.join("");
  expect(drawn).toContain("one\r\n");
  expect(drawn).toContain("two\r\n");
  for (const chunk of manager.bytes(started.runId).chunks) expect(chunk.endsWith("\r\n")).toBe(true);

  const streams = manager.output(started.runId).lines.map((line) => `${line.stream}:${line.text}`);
  expect(streams).toContain("stdout:one");
  expect(streams).toContain("stderr:two");
});

test("a pipe-launched run says it has no keyboard rather than swallowing keystrokes", async () => {
  const manager = manage();
  const started = await manager.start(input(temp("nokeys"), { config: config({ command: "sleep 1" }) }));
  await expect(manager.write(started.runId, "y\r")).rejects.toThrow(/without a terminal/);
  await expect(manager.resize(started.runId, 80, 24)).rejects.toThrow(/without a terminal/);

  const { launcher, state } = fakePty();
  const withPty = manage(launcher);
  const other = await withPty.start(input(temp("keys")));
  expect(await withPty.write(other.runId, "y\r")).toBe(true);
  expect(await withPty.resize(other.runId, 132, 43)).toBe(true);
  expect(state.wrote).toEqual(["y\r"]);
  expect(state.resized).toEqual([[132, 43]]);
});

test("the run route table carries the byte view and the keyboard — and still carries /run/output", async () => {
  for (const [method, tail] of [
    ["GET", "/run/output"],
    ["GET", "/run/bytes"],
    ["POST", "/run/write"],
    ["POST", "/run/resize"],
  ] as const) {
    expect(matchRunRoute(method, tail)).toBeDefined();
  }
  expect(matchRunRoute("GET", "/run/write")).toBeUndefined();
  expect(matchRunRoute("POST", "/run/bytes")).toBeUndefined();
});

test("the routes are wired to the capability, and refuse a shape they cannot serve", async () => {
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const dir = temp("routes");
  const store = new RunStore(temp("store"));
  const capability = storeRunCapability({
    store,
    manager,
    context: () => ({ sessionId: "sess_1", projectId: "proj_1", worktreePath: dir }),
  });
  const call = (method: string, tail: string, body: Record<string, unknown> = {}) => {
    const matched = matchRunRoute(method, tail);
    if (!matched) throw new Error(`no route for ${method} ${tail}`);
    return matched.route.handle({ params: matched.params, input: body, capability });
  };

  const started = await manager.start(input(dir));
  state.events!.output("stdout", "\x1b[32mup\x1b[0m");
  expect(await until(() => manager.bytes(started.terminalId).chunks.length > 0)).toBe(true);

  expect(await call("GET", "/run/bytes")).toEqual({ chunks: ["\x1b[32mup\x1b[0m"], cursor: 1, dropped: 0 });
  expect(await call("POST", "/run/write", { data: "y\r" })).toEqual({ delivered: true });
  expect(await call("POST", "/run/resize", { cols: 120, rows: 30 })).toEqual({ resized: true });
  expect(state.wrote).toEqual(["y\r"]);

  await expect(call("POST", "/run/write", {})).rejects.toThrow(/data/);
  await expect(call("POST", "/run/resize", { cols: 0, rows: 30 })).rejects.toThrow(/cols/);
});
