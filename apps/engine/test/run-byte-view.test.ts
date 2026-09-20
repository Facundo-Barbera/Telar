/**
 * A RUN'S OUTPUT IN THE SHAPE A TERMINAL CAN DRAW — the byte view (#198).
 *
 * `manager.ts` has said since W4 that the lines it keeps are a DEGRADED VIEW of
 * a pseudo-terminal's output. This is the undegraded one, and the three things
 * that can go wrong with it are what this file is built around:
 *
 *   - IT COULD SHOW A SECRET. The ring is fed from `createPtyRedactor`'s
 *     OUTPUT. Wiring it to the input would look identical in every screenshot
 *     and in every line-based test — so the assertion here is an EQUALITY
 *     against the fully-redacted text, which an unmasked buffer fails and an
 *     empty one fails too.
 *   - IT COULD DESYNC A READER. Half of a `CSI 1;31 m` is not a shorter escape,
 *     it is a parser desync that eats whatever text follows. The ring drops
 *     WHOLE CHUNKS, and every chunk left the redactor whole, so the assertion
 *     is that what survives eviction is an exact multiple of the pattern that
 *     went in — which a flat buffer cut at a character limit cannot satisfy.
 *   - IT COULD BE AN EMPTY BLACK BOX WITH NO ELECTRON. There is no PTY under
 *     `bun run src/main.ts`, and a Run tab that drew nothing there would be a
 *     regression against the `<pre>` it replaced. So the pipe launcher feeds
 *     the ring too, and that is asserted against a real child process.
 *
 * AND `/run/output` IS STILL HERE. Every case that adds a byte assertion keeps
 * its line assertion beside it: the two views are both read by somebody — an
 * agent wants lines, an emulator wants bytes — and a change that quietly made
 * one the other's replacement would pass a file that only checked the new one.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunLaunchEvents, RunLauncher } from "../src/run/launcher";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { escapeScan, PTY_MASK } from "../src/run/pty-stream";
import { matchRunRoute } from "../src/run/routes";
import { RunStore } from "../src/run/store";
import { storeRunCapability } from "../src/run/store-capability";
import type { RunConfiguration } from "../src/run/types";

const managers: RunManager[] = [];
const tempDirs: string[] = [];

const temp = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-bytes-${label}-`));
  tempDirs.push(dir);
  return dir;
};

/** Nothing this file starts outlives it. */
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
  config: config(),
  worktreePath: dir,
  ...overrides,
});

/**
 * A launcher that IS a pty as far as the manager's capture path is concerned,
 * and starts nothing.
 *
 * `kind` is the whole of what `capture()` branches on, so this reaches the byte
 * path exactly as `terminalLauncher` does — without a loopback port, which
 * `run-terminal-channel.test.ts` already drives the real server over.
 */
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
        stop: () => state.events?.exited({ exitCode: 0 }),
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

/** A manager whose process-group questions never reach a real pid. */
function manage(launcher?: RunLauncher): RunManager {
  const manager = new RunManager({
    ...(launcher ? { launcher } : {}),
    kill: () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
    groupDrainMs: 10,
    stopGraceMs: 50,
  });
  managers.push(manager);
  return manager;
}

/** Wait for a condition without holding the loop open past the test. */
async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ── redaction reaches the byte view ─────────────────────────────────────────

test("the ring holds the redactor's OUTPUT, so a screen keeps its columns and loses its secret", async () => {
  const secret = "sk-live-9f41c2b7";
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("mask"), { config: config({ env: [{ key: "TOKEN", value: secret, secret: true }] }) }));

  // Split ACROSS PUSHES, straddling both the escape and the secret — the two
  // places an eager scrub leaks and a careless cut desyncs.
  const screen = `\x1b[2J\x1b[1;1Hkey=${secret}\x1b[2;1Hdone`;
  for (let at = 0; at < screen.length; at += 5) state.events!.output("stdout", screen.slice(at, at + 5));

  expect(await until(() => manager.bytes(started.runId).chunks.join("").includes("done"))).toBe(true);
  const drawn = manager.bytes(started.runId).chunks.join("");

  // THE EQUALITY, which only the working thing produces. "the secret is absent"
  // is satisfied by an empty ring; "the length is unchanged" is satisfied by a
  // ring that never masked anything.
  expect(drawn).toBe(`\x1b[2J\x1b[1;1Hkey=${PTY_MASK.repeat(secret.length)}\x1b[2;1Hdone`);
  expect(drawn).not.toContain(secret);
  expect(drawn).toHaveLength(screen.length);

  // AND THE LINE VIEW IS STILL THERE AND STILL REDACTED. Both doors, not one.
  const lines = manager.output(started.runId).lines.map((line) => line.text).join("");
  expect(lines).not.toContain(secret);
});

test("every chunk the ring hands back is escape-whole, however the bytes were sliced", async () => {
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("escapes")));

  // One byte at a time: every escape sequence is split across pushes.
  const text = `\x1b[31mred\x1b[0m plain \x1b]0;a title\x07tail`;
  for (const character of text) state.events!.output("stdout", character);

  expect(await until(() => manager.bytes(started.runId).chunks.join("").includes("tail"))).toBe(true);
  const { chunks } = manager.bytes(started.runId);
  expect(chunks.join("")).toBe(text);
  // A chunk that ended mid-sequence would report a `pending` offset. The
  // concatenation being right is not enough: the ring hands these back one at a
  // time and an emulator is written one at a time.
  for (const chunk of chunks) expect(escapeScan(chunk).pending).toBe(-1);
});

// ── eviction, which is where a flat buffer would desync ─────────────────────

test("the ring drops whole chunks, so what survives is never half a sequence", async () => {
  const { launcher, state } = fakePty();
  const manager = manage(launcher);
  const started = await manager.start(input(temp("evict")));

  // Each push is one complete, self-contained cell: colour on, a character,
  // colour off. Past the chunk ceiling the ring has to start dropping.
  const unit = "\x1b[31mx\x1b[0m";
  for (let index = 0; index < 4_200; index += 1) state.events!.output("stdout", unit);
  expect(await until(() => manager.bytes(started.runId).dropped > 0)).toBe(true);

  const { chunks, cursor, dropped } = manager.bytes(started.runId);
  const retained = chunks.join("");
  // THE SHARP ONE. A flat buffer trimmed to a character budget would leave a
  // head beginning `31mx…` — text that reads as escape PARAMETERS and desyncs
  // the parser. An exact multiple of the unit cannot be produced that way.
  expect(retained).toBe(unit.repeat(chunks.length));
  expect(retained.startsWith("\x1b[31m")).toBe(true);
  expect(escapeScan(retained).pending).toBe(-1);

  // The gap is REPORTED rather than hidden, and the arithmetic closes: what was
  // dropped plus what is held is what was written.
  expect(dropped).toBeGreaterThan(0);
  expect(cursor).toBe(dropped + chunks.length);
  expect(cursor).toBe(4_200);

  // A reader resuming from behind the drop is given the retained window rather
  // than an error or an empty answer.
  expect(manager.bytes(started.runId, 0).chunks.length).toBe(chunks.length);
});

// ── no Electron: a terminal, not a black box ────────────────────────────────

test("a pipe-launched run still fills the byte view, interleaved and CRLF-terminated", async () => {
  // THE CASE THE INVESTIGATION SAID TO DECIDE RATHER THAN DEFAULT. Under `bun
  // run src/main.ts`, in CI, or headless there is no pseudo-terminal at all.
  // The Run tab must still draw something, so the redacted lines go back
  // together as bytes — one device, because a terminal is one device, and with
  // the carriage return an emulator needs to get its column back.
  const manager = manage();
  const started = await manager.start(
    input(temp("pipes"), { config: config({ command: "printf 'one\\n'; printf 'two\\n' 1>&2" }) }),
  );
  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);

  const drawn = manager.bytes(started.runId).chunks.join("");
  expect(drawn).toContain("one\r\n");
  expect(drawn).toContain("two\r\n");
  // Every chunk ends a line: a `\n` with no `\r` would draw a staircase.
  for (const chunk of manager.bytes(started.runId).chunks) expect(chunk.endsWith("\r\n")).toBe(true);

  // And the line view still separates the two streams, which is the thing the
  // byte view gives up and `<pre>` had.
  const streams = manager.output(started.runId).lines.map((line) => `${line.stream}:${line.text}`);
  expect(streams).toContain("stdout:one");
  expect(streams).toContain("stderr:two");
});

test("a pipe-launched run says it has no keyboard rather than swallowing keystrokes", async () => {
  // `stdio: ["ignore", …]` — stdin is /dev/null, so there is genuinely nothing
  // to type into. A `write` that answered `true` and went nowhere would be the
  // worse answer, and opening stdin would make every headless run block on a
  // read instead of seeing EOF.
  const manager = manage();
  const started = await manager.start(input(temp("nokeys"), { config: config({ command: "sleep 1" }) }));
  await expect(manager.write(started.runId, "y\r")).rejects.toThrow(/without a terminal/);
  await expect(manager.resize(started.runId, 80, 24)).rejects.toThrow(/without a terminal/);

  // The control, in the same file: a run that DOES have a terminal takes both.
  const { launcher, state } = fakePty();
  const withPty = manage(launcher);
  const other = await withPty.start(input(temp("keys")));
  expect(await withPty.write(other.runId, "y\r")).toBe(true);
  expect(await withPty.resize(other.runId, 132, 43)).toBe(true);
  expect(state.wrote).toEqual(["y\r"]);
  expect(state.resized).toEqual([[132, 43]]);
});

// ── the doors ───────────────────────────────────────────────────────────────

test("the run route table carries the byte view and the keyboard — and still carries /run/output", async () => {
  // `/run/output` STAYING IS A CONSTRAINT, not an accident: `run_output` is an
  // agent tool that wants lines, and a session on a paired Mac reaches its run
  // over this same host hop because `terminalBridge()` is local-only by design.
  for (const [method, tail] of [
    ["GET", "/run/output"],
    ["GET", "/run/bytes"],
    ["POST", "/run/write"],
    ["POST", "/run/resize"],
  ] as const) {
    expect(matchRunRoute(method, tail)).toBeDefined();
  }
  // And the table is still closed: a plausible neighbour is not a route.
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

  await manager.start(input(dir));
  state.events!.output("stdout", "\x1b[32mup\x1b[0m");
  expect(await until(() => manager.bytes(manager.activeRun("proj_1")!.runId).chunks.length > 0)).toBe(true);

  expect(await call("GET", "/run/bytes")).toEqual({ chunks: ["\x1b[32mup\x1b[0m"], cursor: 1, dropped: 0 });
  expect(await call("POST", "/run/write", { data: "y\r" })).toEqual({ delivered: true });
  expect(await call("POST", "/run/resize", { cols: 120, rows: 30 })).toEqual({ resized: true });
  expect(state.wrote).toEqual(["y\r"]);

  // `data` MAY BE EMPTY AND MAY NOT BE ABSENT — a caller that meant something
  // and sent nothing is a mistake worth naming.
  await expect(call("POST", "/run/write", {})).rejects.toThrow(/data/);
  // A geometry that is not a positive whole number is refused rather than
  // handed to a PTY that would read it as zero and draw nothing.
  await expect(call("POST", "/run/resize", { cols: 0, rows: 30 })).rejects.toThrow(/cols/);
});
