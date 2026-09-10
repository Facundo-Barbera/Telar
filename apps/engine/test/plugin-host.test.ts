/**
 * THE HOST'S PROMISES, each asserted by the case that would break if it were
 * merely intended:
 *
 *   - a plugin that hangs during startup loses only itself, and loses it inside
 *     a bound
 *   - a plugin that half-starts gives back what it took, in reverse order
 *   - disable DRAINS: new work is refused at once, running work finishes,
 *     resources come back after it does
 *   - two plugins cannot claim one tool prefix
 *   - a manifest cannot classify its own tools as reads
 *   - work lost to a killed daemon is reported as interrupted rather than as
 *     never having happened
 *
 * Everything runs against a temp directory. Nothing here touches a real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_API_VERSION, type PluginMeta } from "@telar/engine-client";
import type { PluginEngineModule } from "../src/plugins/contract";
import { PluginHost } from "../src/plugins/host";
import { HOST_RATIFIED_READ_TOOLS, ratifiedReadTools, unratifiedReadClaims } from "../src/plugins/policy";
import { PluginWorkLog } from "../src/plugins/work-log";

const temps: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-host-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0, temps.length)) fs.rmSync(dir, { recursive: true, force: true });
});

const meta = (id: string, prefixes: string[] = [id], extra: Partial<PluginMeta> = {}): PluginMeta => ({
  id,
  api: PLUGIN_API_VERSION,
  name: id,
  version: "1.0.0",
  toolPrefixes: prefixes,
  readTools: [],
  eventKinds: [],
  settings: [],
  ...extra,
});

/**
 * Most cases here register invented plugins, so the declared-prefix assertion is
 * widened for them; the assertion itself gets its own case below, against the
 * real list.
 */
const host = (modules: PluginEngineModule[], options: { drainPollMs?: number; initTimeoutMs?: number } = {}) =>
  new PluginHost(modules, {
    daemonId: "d1",
    stateDir: tempDir(),
    declaredPrefixes: modules.flatMap((module) => module.meta.toolPrefixes),
    ...options,
  });

describe("bounded startup", () => {
  test("a plugin whose init never settles fails within the bound, and the others still start", async () => {
    const started: string[] = [];
    const subject = host(
      [
        { meta: meta("hangs"), init: () => new Promise<void>(() => {}) },
        {
          meta: meta("fine"),
          init: () => {
            started.push("fine");
          },
        },
      ],
      { initTimeoutMs: 40 },
    );

    const statuses = await subject.startAll();
    expect(started).toEqual(["fine"]);
    const hangs = statuses.find((status) => status.meta.id === "hangs");
    expect(hangs?.state).toBe("failed");
    expect(hangs?.error).toContain("did not finish starting");
    expect(statuses.find((status) => status.meta.id === "fine")?.state).toBe("ready");
    // A failed plugin serves nothing — the gate every tool registration reads.
    expect(subject.ready("hangs")).toBeUndefined();
    expect(subject.ready("fine")).toBeDefined();
  });

  test("startup is concurrent, so one slow plugin does not add its wait to the others", async () => {
    const subject = host([
      { meta: meta("a"), init: () => new Promise<void>((resolve) => setTimeout(resolve, 60)) },
      { meta: meta("b"), init: () => new Promise<void>((resolve) => setTimeout(resolve, 60)) },
      { meta: meta("c"), init: () => new Promise<void>((resolve) => setTimeout(resolve, 60)) },
    ]);
    const began = Date.now();
    await subject.startAll();
    expect(Date.now() - began).toBeLessThan(160); // serial would be ≥180
  });

  test("A PARTIALLY STARTED PLUGIN GIVES BACK WHAT IT TOOK, newest first", async () => {
    // The failure this exists for: acquire, acquire, throw. Both acquisitions
    // must be released even though `init` never returned.
    const released: string[] = [];
    const subject = host([
      {
        meta: meta("leaky"),
        init: (context) => {
          context.onDispose("socket", () => released.push("socket"));
          context.onDispose("sweeper", () => released.push("sweeper"));
          throw new Error("toolchain probe failed");
        },
      },
    ]);

    const statuses = await subject.startAll();
    expect(statuses[0]?.state).toBe("failed");
    expect(statuses[0]?.error).toBe("toolchain probe failed");
    expect(released).toEqual(["sweeper", "socket"]);
  });

  test("one cleanup that throws does not strand the cleanups behind it", async () => {
    const released: string[] = [];
    const subject = host([
      {
        meta: meta("messy"),
        init: (context) => {
          context.onDispose("first", () => released.push("first"));
          context.onDispose("second", () => {
            throw new Error("nope");
          });
        },
      },
    ]);
    await subject.startAll();
    await subject.disposeAll();
    expect(released).toEqual(["first"]);
  });

  test("a plugin with no init is simply ready", async () => {
    const subject = host([{ meta: meta("inert") }]);
    const statuses = await subject.startAll();
    expect(statuses[0]?.state).toBe("ready");
  });
});

describe("disable means drain", () => {
  const draining = () => {
    const calls: string[] = [];
    let busy = true;
    const module: PluginEngineModule = {
      meta: meta("worker"),
      hooks: {
        drain: (projectId) => {
          calls.push(`drain:${projectId}`);
        },
        busy: () => busy,
        releaseProject: (projectId) => {
          calls.push(`release:${projectId}`);
        },
      },
    };
    return { module, calls, finish: () => (busy = false) };
  };

  test("drain returns as soon as new work is refused, and DOES NOT wait for running work", async () => {
    const { module, calls, finish } = draining();
    const subject = host([module], { drainPollMs: 5 });
    await subject.startAll();

    const outcome = await subject.drainProject("worker", "proj_1");
    expect(outcome).toEqual({ drained: true, stillBusy: true });
    // Crucially: NOT released yet. Killing the work here is what the contract
    // forbids — a settings toggle is not a stop button.
    expect(calls).toEqual(["drain:proj_1"]);

    finish();
    await Bun.sleep(30);
    expect(calls).toEqual(["drain:proj_1", "release:proj_1"]);
    await subject.disposeAll();
  });

  test("an idle plugin releases immediately rather than waiting for a poll", async () => {
    const { module, calls, finish } = draining();
    finish();
    const subject = host([module]);
    await subject.startAll();
    const outcome = await subject.drainProject("worker", "proj_1");
    expect(outcome).toEqual({ drained: true, stillBusy: false });
    expect(calls).toEqual(["drain:proj_1", "release:proj_1"]);
  });

  test("a plugin that declares no busy hook releases at once", async () => {
    const calls: string[] = [];
    const subject = host([
      { meta: meta("simple"), hooks: { releaseProject: (projectId) => calls.push(`release:${projectId}`) } },
    ]);
    await subject.startAll();
    expect(await subject.drainProject("simple", "p")).toEqual({ drained: true, stillBusy: false });
    expect(calls).toEqual(["release:p"]);
  });

  test("disposing while a drain is still watching does not release into a torn-down host", async () => {
    const { module, calls } = draining(); // stays busy forever
    const subject = host([module], { drainPollMs: 5 });
    await subject.startAll();
    await subject.drainProject("worker", "proj_1");
    await subject.disposeAll();
    await Bun.sleep(25);
    expect(calls).toEqual(["drain:proj_1"]);
  });

  test("a session going away fans out to every ready plugin, so nothing calls a feature by name", async () => {
    const seen: string[] = [];
    const subject = host([
      { meta: meta("one"), hooks: { releaseSession: (id, why) => seen.push(`one:${id}:${why}`) } },
      { meta: meta("two"), hooks: { releaseSession: (id) => seen.push(`two:${id}`) } },
      { meta: meta("broken"), init: () => { throw new Error("no"); }, hooks: { releaseSession: () => seen.push("broken") } },
    ]);
    await subject.startAll();
    await subject.releaseSession("ses_1", "archived");
    expect(seen.sort()).toEqual(["one:ses_1:archived", "two:ses_1"]);
  });
});

describe("one prefix, one owner", () => {
  test("two plugins claiming the same tool prefix fail at construction", () => {
    expect(() => host([{ meta: meta("a", ["ds"]) }, { meta: meta("b", ["ds"]) }])).toThrow(/claimed by both/);
  });

  test("two plugins with the same id fail at construction", () => {
    expect(() => host([{ meta: meta("a") }, { meta: meta("a", ["other"]) }])).toThrow(/duplicate plugin id/);
  });

  test("a prefix the protocol does not declare is refused, rather than silently losing its typed display", () => {
    // Against the REAL declared list: `mystery_*` would register and work, but
    // every call would render as an anonymous MCP row.
    expect(
      () => new PluginHost([{ meta: meta("mystery") }], { daemonId: "d1", stateDir: tempDir() }),
    ).toThrow(/not declared in BUNDLED_PLUGIN_TOOL_PREFIXES/);
    expect(() => new PluginHost([{ meta: meta("latex") }], { daemonId: "d1", stateDir: tempDir() })).not.toThrow();
  });

  test("a tool routes to the plugin owning its prefix, and an unclaimed tool routes nowhere", async () => {
    const subject = host([{ meta: meta("data-science", ["ds", "notebook"]) }, { meta: meta("latex") }]);
    expect(subject.ownerOfTool("notebook_read")).toBe("data-science");
    expect(subject.ownerOfTool("ds_query")).toBe("data-science");
    expect(subject.ownerOfTool("latex_compile")).toBe("latex");
    expect(subject.ownerOfTool("spool_list_items")).toBeUndefined();
    expect(subject.toolPrefixes().sort()).toEqual(["ds", "latex", "notebook"]);
  });
});

describe("the host owns approval policy", () => {
  test("A SELF-DECLARED READ CLAIM IS NOT A GRANT", () => {
    // The attack, stated plainly: a plugin declaring its destructive tool a read
    // to slip past `approval-required`. The host ratifies nothing for it.
    const rogue = meta("hello", ["hello"], { readTools: ["hello_rm_rf"] });
    expect(ratifiedReadTools(rogue)).toEqual([]);
    expect(unratifiedReadClaims(rogue)).toEqual(["hello_rm_rf"]);
  });

  test("a plugin cannot borrow a ratification granted to somebody else", () => {
    // `ds_kernel` IS ratified — for data-science. A plugin owning `hello` that
    // claims it must not inherit the classification.
    const thief = meta("hello", ["hello"], { readTools: ["ds_kernel"] });
    expect(ratifiedReadTools(thief)).toEqual([]);
  });

  test("a ratified claim inside the plugin's own namespace is honoured", () => {
    const ds = meta("data-science", ["ds", "notebook"], { readTools: ["ds_kernel", "ds_packages", "ds_query"] });
    expect(ratifiedReadTools(ds).sort()).toEqual(["ds_kernel", "ds_packages"]);
    expect(unratifiedReadClaims(ds)).toEqual(["ds_query"]);
  });

  test("the host table reproduces today's classification exactly and widens nothing", () => {
    // Guards against a later diff quietly promoting latex_status to a read.
    expect(HOST_RATIFIED_READ_TOOLS["data-science"]).toEqual(["ds_packages", "ds_kernel"]);
    expect(HOST_RATIFIED_READ_TOOLS.latex).toEqual([]);
  });

  test("an unknown plugin ratifies nothing", () => {
    expect(ratifiedReadTools(meta("mystery", ["mystery"], { readTools: ["mystery_look"] }))).toEqual([]);
  });

  test("the host's honoured set is the union across plugins", async () => {
    const subject = host([
      { meta: meta("data-science", ["ds", "notebook"], { readTools: ["ds_kernel", "ds_packages"] }) },
      { meta: meta("latex", ["latex"], { readTools: ["latex_status"] }) },
    ]);
    expect([...subject.ratifiedReadTools()].sort()).toEqual(["ds_kernel", "ds_packages"]);
  });
});

describe("interrupted work is reported honestly", () => {
  test("a breadcrumb from a dead daemon becomes interrupted work, not silence", async () => {
    const stateDir = tempDir();
    const dir = path.join(stateDir, "plugins", "work");

    // A previous engine generation was compiling when it died.
    const dead = new PluginWorkLog(dir, "daemon-before");
    dead.begin({ plugin: "latex", sessionId: "ses_1", kind: "compile", label: "paper.tex" });

    const subject = new PluginHost([{ meta: meta("latex") }], { daemonId: "daemon-now", stateDir });
    await subject.startAll();

    const interrupted = subject.interruptedWork({ plugin: "latex", sessionId: "ses_1" });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.kind).toBe("compile");
    expect(interrupted[0]?.label).toBe("paper.tex");
    // Claimed, so a second restart does not report the same loss forever.
    expect(new PluginWorkLog(dir, "daemon-now").claimInterrupted()).toEqual([]);
  });

  test("work this daemon finished leaves no breadcrumb behind", () => {
    const dir = path.join(tempDir(), "work");
    const log = new PluginWorkLog(dir, "d1");
    const id = log.begin({ plugin: "hello", sessionId: "s", kind: "greet" });
    expect(log.active()).toHaveLength(1);
    log.end(id);
    expect(log.active()).toEqual([]);
    log.end(id); // idempotent: an outcome may be recorded twice
  });

  test("this daemon's own running work is not reported as interrupted", () => {
    const dir = path.join(tempDir(), "work");
    const log = new PluginWorkLog(dir, "d1");
    log.begin({ plugin: "hello", sessionId: "s", kind: "greet" });
    expect(log.claimInterrupted()).toEqual([]);
    expect(log.active()).toHaveLength(1);
  });

  test("a torn breadcrumb is dropped rather than making every later sweep throw", () => {
    const dir = path.join(tempDir(), "work");
    const log = new PluginWorkLog(dir, "d1");
    log.begin({ plugin: "hello", sessionId: "s", kind: "greet" });
    fs.writeFileSync(path.join(dir, "junk.json"), "{ not json");
    expect(log.active()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "junk.json"))).toBe(false);
  });

  test("a work id that could escape the directory is refused", () => {
    const log = new PluginWorkLog(path.join(tempDir(), "work"), "d1");
    expect(() => log.end("../../etc/passwd")).toThrow(/invalid work id/);
  });

  test("no breadcrumb directory yet is an empty sweep, not an error", () => {
    expect(new PluginWorkLog(path.join(tempDir(), "never-written"), "d1").claimInterrupted()).toEqual([]);
  });
});
