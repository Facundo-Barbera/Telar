// WHICH MCP SERVERS A SESSION KIND MOUNTS — story 5.6's project-less seam.
//
// WHAT THIS FILE HAS TO PROVE, and it is two different KINDS of claim:
//   1. THE SHAPE. Every project-anchored kind mounts the same four servers the
//      chat route's own literal mounted before this registry existed, and the
//      master mounts the workspace server ALONE. A kind with no mount throws
//      rather than coming up with an empty toolset, and no two modules can
//      register a mount for the same kind.
//   2. THE SCOPE. The master's workspace server is UNSCOPED — a cross-project
//      view — and a project session's is not. That is a claim about behaviour,
//      not about a name, so it is proved by CALLING both mounts against a real
//      store rather than by reading the source — `list_items` for the READ half
//      and `update_item` for the WRITE half, which a review pointed out was the
//      one with a blast radius and the one this file used to leave unmeasured.
//
// THE SCOPE HALF RUNS IN A SANDBOXED CHILD, and the reason is the same one
// session-profiles.test.ts carries: core's workspace store writes under the
// resolved state root (createItem calls ensureWorkspace, which mkdirs), and
// outside a sandbox that root is the operator's real ~/.telar. Mutating
// process.env.TELAR_HOME in the shared bun process is equally forbidden — every
// suite runs in ONE process — so the sanctioned pattern is a child with HOME and
// TELAR_HOME pointed at throwaways, importing by ABSOLUTE PATH so a temp
// directory with no node_modules of its own still resolves.
//
// NOTHING HERE MOCKS @telar/core. workspace-mcp.test.ts does, deliberately, to
// prove the SERVER's behaviour against a store double; this file's scope claim
// is about which server was constructed, and a double would let it pass while
// the mount handed the store a project it should not have.
// @ts-expect-error no @types/bun in this workspace
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_KINDS, type AccountProfile, type SessionKind } from "@telar/core";
import {
  masterSessionMcpMount,
  projectSessionMcpMount,
  registerSessionMcpMount,
  registerSessionMcpMounts,
  registeredMcpKinds,
  resetSessionMcpMounts,
  resolveSessionMcpServers,
  type SessionMcpContext,
} from "./session-mcp";

// Captured at MODULE SCOPE, immediately after the import above — this IS the
// registration side effect app/api/chat/route.ts's bare import depends on,
// observed rather than described. No later reset can make it lie.
const KINDS_AFTER_IMPORT = [...registeredMcpKinds()];

const account = { name: "facundo@personal", provider: "claude" } as unknown as AccountProfile;

const ctx = (over: Partial<SessionMcpContext> = {}): SessionMcpContext => ({
  project: "aurora",
  account,
  objectiveSeed: "ship the thing",
  link: {} as SessionMcpContext["link"],
  getSessionId: () => "sess-1",
  getMessageId: () => "run-1",
  browserScopeKey: "aurora:draft:run-1",
  ...over,
});

// Every suite below re-registers what it needs, and the module-scope Map leaks
// across FILES as well as tests (one bun process), so the shipped registration
// is restored on the way out. Without this a later suite that imports
// @/lib/session-mcp would find whichever registry this file left behind.
afterEach(() => {
  resetSessionMcpMounts();
  registerSessionMcpMounts();
});

describe("the registration side effect route.ts depends on", () => {
  test("importing @/lib/session-mcp mounts EVERY session kind", () => {
    // A kind with a profile and no mount is a session that comes up with no
    // tools at all and says nothing about it — the silent degradation AD-11
    // exists to end. The equality with SESSION_KINDS is what makes adding a
    // kind to core fail HERE rather than at the first request.
    expect([...KINDS_AFTER_IMPORT].sort()).toEqual([...SESSION_KINDS].sort());
  });
});

describe("5.6 what each kind mounts", () => {
  test("every project-anchored kind mounts the route's own four servers, by name", () => {
    // MEASURED FROM THE ROUTE'S BASELINE LITERAL: loom, ultra, workspace,
    // browser — unconditional for all four kinds, escalation included. What an
    // escalation session does not get is loom's and ultra's TOOLS (its profile
    // denies them), not their servers; a mount that "tidied" them away here
    // would be a behaviour change wearing a refactor's clothes.
    for (const kind of ["project", "planner", "steerer", "escalation"] as const) {
      expect(Object.keys(resolveSessionMcpServers(kind, ctx())).sort()).toEqual([
        "browser",
        "loom",
        "ultra",
        "workspace",
      ]);
    }
  });

  test("the master mounts the workspace server and nothing else", () => {
    const mounted = resolveSessionMcpServers("master", ctx({ project: undefined }));
    expect(Object.keys(mounted)).toEqual(["workspace"]);
    // Each absence is a decision: loom and ultra both take a project slug they
    // dereference to a manifest root, and the master has none; browser is the
    // shared human-and-agent surface, and the master chat surface does not
    // exist yet (story 7).
    for (const absent of ["loom", "ultra", "browser"]) {
      expect(Object.keys(mounted)).not.toContain(absent);
    }
  });

  test("the master mount needs no project — it is the whole point of the seam", () => {
    // The route's old MCP literal constructed loom/ultra/workspace with
    // `project` unconditionally. This is the assertion that the master path
    // never reads it: same call, no project, no throw.
    expect(() => masterSessionMcpMount(ctx({ project: undefined }))).not.toThrow();
    expect(Object.keys(masterSessionMcpMount(ctx({ project: undefined })))).toEqual([
      "workspace",
    ]);
  });

  test("the mounts are the SAME function for the four project kinds — one literal, not four copies", () => {
    // If these ever diverge, the "moved verbatim" claim in session-mcp.ts's
    // header stops being true and each kind's tool surface becomes its own
    // thing to keep in step.
    resetSessionMcpMounts();
    registerSessionMcpMounts();
    const servers = (["project", "planner", "steerer", "escalation"] as const).map((k) =>
      Object.keys(resolveSessionMcpServers(k, ctx())).sort().join(","),
    );
    expect(new Set(servers).size).toBe(1);
  });

  test("a mount READS NOTHING LIVE while it is being built — the getters stay getters", () => {
    // #28's persistent runtime, and the property that decided this is a factory
    // registry rather than a `SessionProfileSpec.mcpServers` field: a mount is
    // constructed ONCE per session runtime and reused across turns, so anything
    // it resolved AT CONSTRUCTION would freeze the creating turn's session id
    // and run id into every later turn's tool calls. That is the exact
    // stale-closure bug the persistent-runtime work fixed.
    //
    // Falsifiable: a mount that wrote `getSessionId()` instead of passing the
    // function through — the natural way to write it, and wrong — trips these
    // counters immediately.
    let sessionReads = 0;
    let messageReads = 0;
    const spy = ctx({
      getSessionId: () => {
        sessionReads += 1;
        return null;
      },
      getMessageId: () => {
        messageReads += 1;
        return null;
      },
    });
    projectSessionMcpMount(spy);
    masterSessionMcpMount(spy);
    expect(sessionReads).toBe(0);
    expect(messageReads).toBe(0);
    // Anti-vacuity: the counters do move when something actually reads them, so
    // the zeroes above are a measurement rather than two unused variables.
    spy.getSessionId();
    spy.getMessageId();
    expect(sessionReads).toBe(1);
    expect(messageReads).toBe(1);
  });
});

describe("5.6 the registry's own discipline", () => {
  test("an unmounted kind THROWS and names the declared ones — never an empty toolset", () => {
    resetSessionMcpMounts();
    registerSessionMcpMount("project", projectSessionMcpMount);
    let message = "";
    try {
      resolveSessionMcpServers("master", ctx());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('no MCP mount declared for "master"');
    expect(message).toContain("Declared kinds: project");
    // The throw has to say WHY, because the realistic cause is a missing
    // side-effect import and the symptom is a model that "forgot" how to read
    // the user's items.
    expect(message).toContain("MODULE SCOPE");
  });

  test("a duplicate mount registration throws — import order must not decide a tool surface", () => {
    resetSessionMcpMounts();
    registerSessionMcpMount("master", masterSessionMcpMount);
    expect(() => registerSessionMcpMount("master", masterSessionMcpMount)).toThrow(
      /already declared/,
    );
  });

  test("resetSessionMcpMounts() empties the registry and re-registration is clean", () => {
    resetSessionMcpMounts();
    expect(registeredMcpKinds()).toEqual([]);
    expect(() => registerSessionMcpMounts()).not.toThrow();
    expect([...registeredMcpKinds()].sort()).toEqual([...SESSION_KINDS].sort());
  });

  test("every SessionKind resolves — the loop a new kind cannot quietly skip", () => {
    for (const kind of SESSION_KINDS as readonly SessionKind[]) {
      const mounted = resolveSessionMcpServers(kind, ctx());
      expect(Object.keys(mounted).length).toBeGreaterThan(0);
      // The workspace server is the one every kind gets: it is the only path a
      // session has to the user's item store.
      expect(Object.keys(mounted)).toContain("workspace");
    }
  });
});

// ── the scope claim, in a sandboxed child ───────────────────────────────────

describe("5.6 the master's workspace server is UNSCOPED, and a project session's is not", () => {
  test("list_items through the master mount sees every project; through a project mount, one", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const core = path.join(here, "..", "..", "..", "packages", "core", "src", "index.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-mcp-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-mcp-home-"));
    try {
      const probe = path.join(dir, "probe.ts");
      fs.writeFileSync(
        probe,
        [
          // BOTH IMPORTS BY ABSOLUTE PATH. The probe lives in a temp directory,
          // and a bare "@telar/core" resolved from there finds a stale copy in
          // bun's install cache (measured). apps/web/node_modules/@telar/core is
          // a symlink to packages/core, so this is the same real module the
          // mount's own imports resolve to.
          `import { resolveSessionMcpServers } from ${JSON.stringify(
            path.join(here, "session-mcp"),
          )};`,
          `import { createItem } from ${JSON.stringify(core)};`,
          // Two items, two projects, one store.
          `createItem({ title: "aurora thing", project: "aurora" });`,
          `const borealis = createItem({ title: "borealis thing", project: "borealis" });`,
          `const account = { name: "facundo@personal", provider: "claude" };`,
          `const base = { account, objectiveSeed: "seed", link: {}, getSessionId: () => "sess-1", getMessageId: () => "run-1", browserScopeKey: "k" };`,
          // Reach the SDK server's registered tools and invoke the handler
          // directly — the idiom workspace-mcp.test.ts and ultra-mcp.test.ts
          // both use.
          // `raw` keeps the isError flag and the UNPARSED text, because a
          // refusal is a plain sentence rather than JSON — parsing it eagerly
          // (which the first version of this helper did) turns a measured refusal
          // into a probe crash.
          `const raw = async (server, name, args) => {`,
          `  const t = server.instance._registeredTools[name];`,
          `  const r = await t.handler(args ?? {}, {});`,
          `  return { isError: !!r.isError, text: (r.content ?? []).map((c) => c.text ?? "").join("") };`,
          `};`,
          `const call = async (server, name, args) => JSON.parse((await raw(server, name, args)).text);`,
          `const master = resolveSessionMcpServers("master", { ...base });`,
          `const scoped = resolveSessionMcpServers("project", { ...base, project: "aurora" });`,
          `const m = await call(master.workspace, "list_items");`,
          `const s = await call(scoped.workspace, "list_items");`,
          `const titles = (r) => (r.items ?? []).map((i) => i.title).sort();`,
          // THE WRITE HALF OF THE SAME CLAIM — the half with a blast radius, and
          // the half a review found unproved. `update_item` checks scope BEFORE
          // the write, so these two calls measure the same predicate the read
          // does, in the direction that mutates.
          `const scopedWrite = await raw(scoped.workspace, "update_item", { itemId: borealis.id, title: "scoped rename" });`,
          `const masterWrite = await raw(master.workspace, "update_item", { itemId: borealis.id, title: "master rename" });`,
          `const after = await call(master.workspace, "list_items");`,
          `console.log(JSON.stringify({`,
          `  master: titles(m), scoped: titles(s),`,
          `  scopedWriteRefused: scopedWrite.isError,`,
          `  masterWriteRefused: masterWrite.isError,`,
          `  titlesAfter: titles(after),`,
          `}));`,
        ].join("\n"),
      );
      const out = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          TELAR_HOME: path.join(dir, "telar"),
          NODE_ENV: "test",
        },
      });
      const line = (out.stdout ?? "").trim().split("\n").pop() ?? "";
      type ProbeAnswer = {
        master: string[];
        scoped: string[];
        scopedWriteRefused: boolean;
        masterWriteRefused: boolean;
        titlesAfter: string[];
      };
      let parsed: ProbeAnswer | null = null;
      try {
        parsed = JSON.parse(line) as ProbeAnswer;
      } catch {
        /* fall through to the diagnostic below */
      }
      if (!parsed) {
        throw new Error(
          `story 5.6: the sandboxed mount-scope probe produced no JSON. ` +
            `status=${out.status} stdout=${JSON.stringify(out.stdout)} ` +
            `stderr=${JSON.stringify(out.stderr)}. CONSEQUENCE: "the master sees every ` +
            `project's items and a project session sees only its own" is UNPROVED while this ` +
            `test reads as green — and that pair is the whole reason the seam exists. ` +
            `NEXT STEP: fix the probe or its module resolution — do not weaken the assertion, ` +
            `and do NOT run the store in this process (it writes under the real ~/.telar).`,
        );
      }
      // CAP-1's briefing is a question about ALL projects at once, and this is
      // the property that makes it answerable.
      expect(parsed.master).toEqual(["aurora thing", "borealis thing"]);
      // …and the isolation the rest of the system maintains is untouched: a
      // project session still sees exactly its own. A mount that passed the
      // master's context through to a scoped server, or a scoped one that
      // dropped its project, both fail here.
      expect(parsed.scoped).toEqual(["aurora thing"]);
      // THE WRITE HALF, WHICH THIS TEST USED TO LEAVE UNPROVED and a review
      // named as "the half with a blast radius". Cross-project MUTATION from the
      // master is INTENDED — CAP-1's briefing is about every project and CAP-2's
      // brain dump files fragments into the ones they belong to, so a master that
      // could read every item and rewrite none would be a receptionist with no
      // pen. It is asserted here so it stays a decision: the day it should not be
      // true, this row is what turns red.
      expect(parsed.masterWriteRefused).toBe(false);
      // …and the scoped mount refuses the SAME id, which is what says the
      // permission came from the mount's scope and not from the item being
      // reachable. `update_item` checks scope before the write, so a refusal here
      // means nothing was written either.
      expect(parsed.scopedWriteRefused).toBe(true);
      // THE OBSERVABLE OUTCOME, so neither flag can be a lie about what landed on
      // disk: the master's rename took, the scoped session's did not.
      expect(parsed.titlesAfter).toEqual(["aurora thing", "master rename"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);
});
