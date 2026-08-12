/**
 * The transport and the owned runtime, driven against a FAKE subprocess.
 *
 * Every test here would otherwise download a Chromium, which is why
 * `SpawnBrowserProcess` is injectable at all — the same seam
 * `createClaudeDriver(loadSdk)` uses in `../src/driver.ts`. The fake speaks
 * newline-delimited JSON-RPC over the same four callbacks the real child does,
 * so what is exercised is the framing, the handshake, the timeouts and the kill
 * escalation rather than a mock of them.
 */
import { describe, expect, test } from "bun:test";
import {
  BrowserRuntime,
  BrowserToolInputError,
  MCP_PROTOCOL_VERSION,
  PlaywrightMcpTransport,
  installBrowser,
  type BrowserProcess,
  type RunOnce,
  type SpawnBrowserProcess,
} from "../src/browser";

type RpcRequest = { id?: number; method: string; params?: Record<string, unknown> };
type Responder = (request: RpcRequest) => Record<string, unknown> | { __error: string } | null;

type FakeChild = {
  command: string;
  args: string[];
  requests: RpcRequest[];
  signals: string[];
  closed: boolean;
  /** Push raw bytes at the transport, newlines and all — or not. */
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /** Answer a request that the responder deliberately left hanging. */
  reply(id: number, result: Record<string, unknown>): void;
  close(reason?: string | null): void;
};

function fakeBrowser(
  options: {
    respond?: Responder;
    /** false models a child that ignores SIGTERM — the case `close()` exists for. */
    exitOnSignal?: boolean;
  } = {},
) {
  const children: FakeChild[] = [];
  const respond: Responder =
    options.respond ??
    ((request) =>
      request.method === "initialize"
        ? { protocolVersion: MCP_PROTOCOL_VERSION }
        : { content: [{ type: "text", text: "ok" }] });

  const spawn: SpawnBrowserProcess = (command, args) => {
    const stdout: ((chunk: string) => void)[] = [];
    const stderr: ((chunk: string) => void)[] = [];
    const closed: ((reason: string | null) => void)[] = [];

    const child: FakeChild = {
      command,
      args: [...args],
      requests: [],
      signals: [],
      closed: false,
      stdout: (chunk) => stdout.forEach((listener) => listener(chunk)),
      stderr: (chunk) => stderr.forEach((listener) => listener(chunk)),
      reply: (id, result) => child.stdout(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`),
      close: (reason = null) => {
        if (child.closed) return;
        child.closed = true;
        closed.forEach((listener) => listener(reason));
      },
    };
    children.push(child);

    const process: BrowserProcess = {
      write: (frame) => {
        const request = JSON.parse(frame) as RpcRequest;
        child.requests.push(request);
        if (request.id === undefined) return; // a notification; nothing to answer
        const answer = respond(request);
        if (answer === null) return; // deliberately left hanging
        // Answer on a later tick, as a real subprocess would.
        queueMicrotask(() => {
          const id = request.id as number;
          if (child.closed) return;
          child.stdout(
            "__error" in answer
              ? `${JSON.stringify({ jsonrpc: "2.0", id, error: { message: answer.__error } })}\n`
              : `${JSON.stringify({ jsonrpc: "2.0", id, result: answer })}\n`,
          );
        });
      },
      onStdout: (listener) => void stdout.push(listener),
      onStderr: (listener) => void stderr.push(listener),
      onClosed: (listener) => void closed.push(listener),
      kill: (signal) => {
        child.signals.push(signal);
        if (options.exitOnSignal !== false) child.close(`killed by ${signal}`);
      },
    };
    return process;
  };

  return { children, spawn };
}

/** Wait for the transport to reach a state, rather than guessing a tick count
 *  — the handshake is several awaits deep and that guess is where a suite
 *  starts failing only on a loaded machine. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
}

const transportOptions = (spawn: SpawnBrowserProcess, extra: Record<string, unknown> = {}) => ({
  spawn,
  cliPath: "/fake/@playwright/mcp/cli.js",
  killGraceMs: 5,
  ...extra,
});

describe("the playwright-mcp transport", () => {
  test("launches the CLI through the current runtime, headless and isolated", async () => {
    const fake = fakeBrowser();
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    await transport.call("browser_snapshot", {});

    expect(fake.children).toHaveLength(1);
    const child = fake.children[0]!;
    // Not the package bin: its shebang is `/usr/bin/env node`, which a Bun-only
    // install does not have.
    expect(child.command).toBe(process.execPath);
    expect(child.args[0]).toBe("/fake/@playwright/mcp/cli.js");
    expect(child.args).toContain("--headless");
    // `--isolated` is what keeps two sessions out of each other's cookies.
    expect(child.args).toContain("--isolated");
    expect(child.args.join(" ")).toContain("--browser chromium");
    expect(child.args.join(" ")).toContain("--viewport-size 1280x800");
    expect(child.args.join(" ")).toContain("--image-responses allow");
    await transport.close();
  });

  test("handshakes with the pinned protocol version and the initialized notification before any tool call", async () => {
    const fake = fakeBrowser();
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    await transport.call("browser_snapshot", { depth: 2 });

    const methods = fake.children[0]!.requests.map((request) => request.method);
    // Order matters: a server that has not seen `notifications/initialized`
    // answers tools/call with a protocol error instead of running the tool.
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(fake.children[0]!.requests[0]!.params?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(fake.children[0]!.requests[2]!.params).toEqual({
      name: "browser_snapshot",
      arguments: { depth: 2 },
    });
    await transport.close();
  });

  test("starts exactly one browser when two calls race the launch", async () => {
    const fake = fakeBrowser();
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    await Promise.all([transport.call("browser_snapshot"), transport.call("browser_list_tabs")]);
    // Two Chromiums on one isolated profile is a launch failure with no
    // obvious cause; the shared `starting` promise is what prevents it.
    expect(fake.children).toHaveLength(1);
    await transport.close();
  });

  test("reassembles a response split across reads, and several arriving in one", async () => {
    const pending = new Map<string, number>();
    const fake = fakeBrowser({
      respond: (request) => {
        if (request.method === "initialize") return { protocolVersion: MCP_PROTOCOL_VERSION };
        pending.set(String(request.params?.name), request.id as number);
        return null; // answered by hand below, in fragments
      },
    });
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    const first = transport.call("browser_snapshot");
    const second = transport.call("browser_list_tabs");
    await until(() => pending.size === 2, "both tool calls to reach the browser");

    const child = fake.children[0]!;
    const frame = (id: number, text: string) =>
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    const one = frame(pending.get("browser_snapshot")!, "snapshot");
    const two = frame(pending.get("browser_list_tabs")!, "tabs");
    // A byte stream has no message boundaries: half a frame, then the rest of
    // it plus a whole second frame in one read. `readline` would have been
    // fine here and dropped the tail if the last newline never came.
    child.stdout(one.slice(0, 12));
    child.stdout(`${one.slice(12)}\n${two}\n`);

    expect((await first).content).toEqual([{ type: "text", text: "snapshot" }]);
    expect((await second).content).toEqual([{ type: "text", text: "tabs" }]);
    await transport.close();
  });

  test("times a call out rather than waiting on a browser that has gone quiet", async () => {
    const fake = fakeBrowser({
      respond: (request) => (request.method === "initialize" ? { protocolVersion: MCP_PROTOCOL_VERSION } : null),
    });
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn, { requestTimeoutMs: 20 }));
    await expect(transport.call("browser_click", { target: "e1" })).rejects.toThrow(/timed out/i);
    expect(transport.lastError).toMatch(/timed out/i);
    await transport.close();
  });

  test("distinguishes a tool that failed from a call that never ran", async () => {
    const failing = fakeBrowser({
      respond: (request) =>
        request.method === "initialize"
          ? { protocolVersion: MCP_PROTOCOL_VERSION }
          : { isError: true, content: [{ type: "text", text: "### Error\nRef e17 not found" }] },
    });
    const transport = new PlaywrightMcpTransport(transportOptions(failing.spawn));
    // A tool that RAN and failed comes back as a result: the agent has to be
    // able to read why, and retry.
    const result = await transport.call("browser_click", { target: "e17" });
    expect(result.isError).toBe(true);
    expect(transport.lastError).toBe("Ref e17 not found");
    await transport.close();

    const broken = fakeBrowser({
      respond: (request) =>
        request.method === "initialize" ? { protocolVersion: MCP_PROTOCOL_VERSION } : { __error: "method not found" },
    });
    const second = new PlaywrightMcpTransport(transportOptions(broken.spawn));
    // A JSON-RPC error means the call never ran at all. Different thing.
    await expect(second.call("browser_click", { target: "e17" })).rejects.toThrow(/method not found/);
    await second.close();
  });

  test("rejects a result whose shape it cannot read instead of reporting an empty page", async () => {
    const fake = fakeBrowser({
      respond: (request) =>
        request.method === "initialize" ? { protocolVersion: MCP_PROTOCOL_VERSION } : { content: "a string" },
    });
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    await expect(transport.call("browser_snapshot")).rejects.toThrow(/unreadable result/);
    await transport.close();
  });

  test("fails a launch with the child's stderr, which is the only diagnosis there is", async () => {
    const fake = fakeBrowser({
      respond: (request) => {
        if (request.method !== "initialize") return null;
        queueMicrotask(() => {
          const child = fake.children[0]!;
          child.stderr("browserType.launch: Executable doesn't exist at /ms-playwright/chromium\n");
          child.close("exited with code 1");
        });
        return null;
      },
    });
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    // Without the stderr ring this is "The controlled browser stopped
    // unexpectedly", which tells nobody to run the browser installer.
    await expect(transport.call("browser_snapshot")).rejects.toThrow(/Executable doesn't exist/);
    expect(transport.running).toBe(false);
  });

  test("rejects everything in flight when the browser exits on its own", async () => {
    const fake = fakeBrowser({
      respond: (request) => (request.method === "initialize" ? { protocolVersion: MCP_PROTOCOL_VERSION } : null),
    });
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    const call = transport.call("browser_navigate", { url: "http://localhost:3000" });
    await until(() => fake.children[0]?.requests.length === 3, "the tool call to reach the browser");
    fake.children[0]!.close("exited with code 1");
    await expect(call).rejects.toThrow(/exited with code 1|stopped unexpectedly/);
    expect(transport.running).toBe(false);
  });

  test("escalates SIGTERM to SIGKILL when the browser ignores the polite signal", async () => {
    const stubborn = fakeBrowser({ exitOnSignal: false });
    const transport = new PlaywrightMcpTransport(transportOptions(stubborn.spawn));
    await transport.call("browser_snapshot");
    await transport.close();
    // The legacy runtime sent SIGTERM and returned. A Chromium wedged on a
    // beforeunload handler survives that, keeps the profile lock, and the next
    // launch for the scope fails for a reason with no visible cause.
    expect(stubborn.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);

    const polite = fakeBrowser();
    const second = new PlaywrightMcpTransport(transportOptions(polite.spawn));
    await second.call("browser_snapshot");
    await second.close();
    // …and a browser that exits on SIGTERM is never SIGKILLed.
    expect(polite.children[0]!.signals).toEqual(["SIGTERM"]);
  });

  test("close is safe on a transport that never started, and safe twice", async () => {
    const fake = fakeBrowser();
    const transport = new PlaywrightMcpTransport(transportOptions(fake.spawn));
    await transport.close();
    expect(fake.children).toHaveLength(0);

    await transport.call("browser_snapshot");
    await transport.close();
    await transport.close();
    expect(fake.children[0]!.signals).toEqual(["SIGTERM"]);
  });
});

describe("the owned browser runtime", () => {
  const runtime = (spawn: SpawnBrowserProcess, extra: Record<string, unknown> = {}) =>
    new BrowserRuntime({ ...transportOptions(spawn), installExitHandler: false, ...extra });

  test("keeps one browser per scope so two sessions cannot see each other's pages", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_navigate", { url: "http://localhost:3000" });
    await browser.call("session:a", "browser_snapshot");
    await browser.call("session:b", "browser_snapshot");

    expect(fake.children).toHaveLength(2);
    expect(browser.scopeKeys).toEqual(["session:a", "session:b"]);
    await browser.close();
  });

  test("requires a scope key rather than defaulting to a shared browser", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await expect(browser.call("", "browser_snapshot")).rejects.toThrow(/scope is required/);
    await expect(browser.call("   ", "browser_snapshot")).rejects.toThrow(/scope is required/);
    expect(fake.children).toHaveLength(0);
    await browser.close();
  });

  test("validates arguments before a browser is ever launched", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await expect(browser.call("session:a", "browser_navigate", { url: "not-a-url" })).rejects.toThrow(
      BrowserToolInputError,
    );
    await expect(browser.call("session:a", "browser_evaluate", {})).rejects.toThrow(/Unknown browser tool/);
    // A typo must not cost a Chromium launch.
    expect(fake.children).toHaveLength(0);
    await browser.close();
  });

  test("rewrites the tab-list alias into the call Playwright actually understands", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_list_tabs");
    expect(fake.children[0]!.requests[2]!.params).toEqual({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    await browser.close();
  });

  test("releases one scope's browser — the operation the legacy runtime had no way to perform", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_snapshot");
    await browser.call("session:b", "browser_snapshot");

    expect(await browser.release("session:a")).toBe(true);
    expect(fake.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(browser.isRunning("session:a")).toBe(false);
    expect(browser.scopeKeys).toEqual(["session:b"]);
    // Releasing a scope that has no browser is not an error, so a session's
    // terminal transition can call it unconditionally.
    expect(await browser.release("session:a")).toBe(false);
    await browser.close();
  });

  test("close stops every browser and refuses further calls", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_snapshot");
    await browser.call("session:b", "browser_snapshot");
    await browser.close();

    expect(fake.children.map((child) => child.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(browser.scopeKeys).toEqual([]);
    // Use-after-close is loud rather than quietly starting a fresh browser.
    await expect(browser.call("session:a", "browser_snapshot")).rejects.toThrow(/closed/);
  });

  test("state does not launch a browser for a scope that has none", async () => {
    const fake = fakeBrowser();
    const browser = runtime(fake.spawn);
    const state = await browser.state("session:a");
    // A browser panel polls this. Legacy `state()` went straight to
    // browser_tabs, so polling started a Chromium per session on screen.
    expect(fake.children).toHaveLength(0);
    expect(state).toEqual({
      scopeKey: "session:a",
      provider: "none",
      running: false,
      tabs: [],
      screenshot: null,
      error: null,
    });
    await browser.close();
  });

  test("state reads tabs and a screenshot from a running browser", async () => {
    const fake = fakeBrowser({
      respond: (request) => {
        if (request.method === "initialize") return { protocolVersion: MCP_PROTOCOL_VERSION };
        const name = String(request.params?.name);
        if (name === "browser_take_screenshot") {
          return { content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] };
        }
        return {
          content: [
            {
              type: "text",
              text: ["- 0: (current) [Telar](http://localhost:3000/)", "- 1: [Docs](https://example.com/)"].join("\n"),
            },
          ],
        };
      },
    });
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_snapshot");

    const state = await browser.state("session:a");
    expect(state.provider).toBe("headless");
    expect(state.running).toBe(true);
    expect(state.error).toBeNull();
    expect(state.tabs).toEqual([
      { id: "0", url: "http://localhost:3000/", title: "Telar", active: true },
      { id: "1", url: "https://example.com/", title: "Docs", active: false },
    ]);
    expect(state.screenshot).toBe("data:image/jpeg;base64,QUJD");
    await browser.close();
  });

  test("state reports a failing browser instead of throwing at the caller", async () => {
    const fake = fakeBrowser({
      respond: (request) =>
        request.method === "initialize"
          ? { protocolVersion: MCP_PROTOCOL_VERSION }
          : { isError: true, content: [{ type: "text", text: "### Error\nNo open pages" }] },
    });
    const browser = runtime(fake.spawn);
    await browser.call("session:a", "browser_snapshot");

    const state = await browser.state("session:a");
    expect(state.tabs).toEqual([]);
    expect(state.screenshot).toBeNull();
    expect(state.error).toBe("No open pages");
    await browser.close();
  });

  test("installs one process-exit handler and REMOVES it on close", async () => {
    const fake = fakeBrowser({ exitOnSignal: false });
    const listeners = new Set<() => void>();
    const exitHooks = {
      on: (_event: "exit", listener: () => void) => void listeners.add(listener),
      off: (_event: "exit", listener: () => void) => void listeners.delete(listener),
    };
    const browser = new BrowserRuntime({ ...transportOptions(fake.spawn), exitHooks });
    await browser.call("session:a", "browser_snapshot");
    expect(listeners.size).toBe(1);

    // `exit` handlers cannot await, so teardown there is a synchronous SIGKILL
    // — anything async silently does not run, and the Chromium is orphaned.
    for (const listener of listeners) listener();
    expect(fake.children[0]!.signals).toEqual(["SIGKILL"]);

    await browser.close();
    // A runtime per session that never unregisters trips Node's eleven-listener
    // warning and then says nothing at all while the leak grows.
    expect(listeners.size).toBe(0);
  });
});

describe("installing the browser binary", () => {
  const installer = (result: { code: number | null; output: string }) => {
    const runs: string[][] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: RunOnce = async (command, args) => {
      runs.push([command, ...args]);
      await gate;
      return result;
    };
    return { runs, run, release };
  };

  test("runs the CLI's installer for the browser the transport actually launches", async () => {
    const { runs, run, release } = installer({ code: 0, output: "Chromium downloaded\n" });
    const install = installBrowser({ run, cliPath: "/fake/cli.js" });
    release();
    expect(await install).toBe("Chromium downloaded");
    // The same word `--browser` gets, because @playwright/mcp maps `chromium`
    // onto its own download name; guessing a different one installs a browser
    // nothing then launches.
    expect(runs).toEqual([[process.execPath, "/fake/cli.js", "install-browser", "chromium"]]);
  });

  test("is single-flight: two sessions discovering the gap at once run one download", async () => {
    const { runs, run, release } = installer({ code: 0, output: "done" });
    const first = installBrowser({ run, cliPath: "/fake/cli.js" });
    const second = installBrowser({ run, cliPath: "/fake/cli.js" });
    release();
    await Promise.all([first, second]);
    // Two downloads into one shared Playwright cache is a corrupted install,
    // not a slow one.
    expect(runs).toHaveLength(1);
  });

  test("fails with the installer's own output, and does not cache the failure", async () => {
    const failing = installer({ code: 1, output: "ENOSPC: no space left on device" });
    const attempt = installBrowser({ run: failing.run, cliPath: "/fake/cli.js" });
    failing.release();
    await expect(attempt).rejects.toThrow(/ENOSPC/);

    // A retry after a failure must actually retry, so a transient download
    // error does not disable the browser for the life of the daemon.
    const retry = installer({ code: 0, output: "done" });
    const second = installBrowser({ run: retry.run, cliPath: "/fake/cli.js" });
    retry.release();
    expect(await second).toBe("done");
    expect(retry.runs).toHaveLength(1);
  });
});
