// The typed in-process event bus (AD-14 / AD-21, CAP-3).
//
// Fixtures only: this suite declares the ONLY event names in the repo. Which
// concrete events a module publishes belongs to that module's own epic — AD-21
// is what makes deferring the catalogue safe — so nothing here should ever be
// promoted into packages/core/src.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  canWake,
  declareEvents,
  declaredEvents,
  eventDeclaration,
  publish,
  resetBus,
  subscribe,
  subscribeAgentFacing,
} from "../src/event-bus";

// The bus touches no state root — but pin one anyway, so the "persists nothing"
// test below has a throwaway root to prove emptiness against and a regression
// can never reach the real ~/.telar. bun runs all files in ONE process.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-event-bus-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = home;

beforeEach(() => {
  process.env.TELAR_HOME = home;
  resetBus();
});

afterAll(() => {
  resetBus();
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const payload = z.object({ id: z.string() });

// One agent-facing and one human-facing fixture module, redeclared per test by
// the beforeEach reset above.
const declareFixtures = () =>
  declareEvents("fixture", {
    "wake-worthy": { deliveryClass: "agent-facing", payload },
    "read-when-you-arrive": { deliveryClass: "human-facing", payload },
  });

const AGENT_FACING = "fixture:wake-worthy";
const HUMAN_FACING = "fixture:read-when-you-arrive";

// ── AC1: the delivery class is a field the TYPE SYSTEM demands ──────────────
// packages/core/tsconfig.json is `include: ["src"], exclude: ["test"]`, so
// `bunx tsc --noEmit` in this workspace NEVER SEES THIS FILE. A bare
// `// @ts-expect-error` here would therefore be a comment wearing a test's
// clothes — exactly the "green test that asserts nothing" story 1.1 spent two
// repair rounds on. So the compile-time claim is proved by actually RUNNING the
// compiler, in both directions, over fixtures generated outside the repo.
// Run the compiler through THIS runtime rather than node_modules/.bin/tsc: the
// shim is `#!/usr/bin/env node` and this repo is bun-only, so there may be no
// `node` on PATH at all.
const REPO_TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const BUS_MODULE = fileURLToPath(new URL("../src/event-bus.ts", import.meta.url)).replace(
  /\.ts$/,
  "",
);
// The fixtures never import zod themselves — `EventDeclaration["payload"]`
// hands them the declared payload type, so they compile from a throwaway
// directory with no node_modules of its own. event-bus.ts's own zod import
// still resolves, from its real location in the workspace.
const FIXTURE_PRELUDE = [
  `import { declareEvents, type EventDeclaration } from ${JSON.stringify(BUS_MODULE)};`,
  `const payload = null as unknown as EventDeclaration["payload"];`,
].join("\n");

const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bus-compile-"));
  try {
    const file = path.join(dir, "fixture.ts");
    fs.writeFileSync(file, `${FIXTURE_PRELUDE}\n${source}\n`);
    const out = spawnSync(
      process.execPath,
      [
        REPO_TSC,
        "--noEmit",
        "--ignoreConfig", // files-on-the-commandline + a tsconfig alongside is an error otherwise
        "--strict",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        file,
      ],
      { encoding: "utf8" },
    );
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("AC1 — the delivery class is a required FIELD, proved against the compiler", () => {
  test("AC1 a declaration object literal missing deliveryClass does NOT typecheck", () => {
    const r = typecheck(`declareEvents("probe", { "thing-happened": { payload } });`);
    expect(r.ok).toBe(false);
    // Not merely "some error": the error must be about the missing field, or
    // this would pass on any unrelated breakage in the fixture.
    expect(r.output).toContain("deliveryClass");
    expect(r.output).toMatch(/is missing in type|Property 'deliveryClass'/);
  });

  test("AC1 the compile proof DISCRIMINATES — the same declaration WITH a class compiles clean", () => {
    // Without this half, a fixture that failed to compile for any reason at all
    // (a bad path, a renamed export) would read as a passing AC1.
    const r = typecheck(
      `declareEvents("probe", { "thing-happened": { deliveryClass: "agent-facing", payload } });\n` +
        `declareEvents("probe2", { "thing-happened": { deliveryClass: "human-facing", payload } });`,
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC1 a @ts-expect-error over the omission is SATISFIED — the pin, checked by tsc itself", () => {
    // This is the `// @ts-expect-error` form the AC asks for, placed where it is
    // actually compiled. It fails the build in BOTH directions: if the omission
    // stops being an error, tsc reports the directive as unused.
    const r = typecheck(
      `// @ts-expect-error a declaration without a delivery class must not typecheck (AC1)\n` +
        `declareEvents("probe", { "thing-happened": { payload } });`,
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC1 an invented delivery class does not typecheck either — the union is closed", () => {
    const r = typecheck(
      `declareEvents("probe", { "thing-happened": { deliveryClass: "push-notification", payload } });`,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("push-notification");
    expect(r.output).toContain("DeliveryClass");
  });

  test("AC1 the runtime guard catches a caller that bypassed the type system", () => {
    // Belt-and-suspenders only — an `as any`, a JS caller, a payload off the
    // wire. Explicitly NOT what satisfies the AC on its own.
    expect(() =>
      declareEvents("probe", { "thing-happened": { payload } as never }),
    ).toThrow(/delivery class/i);
    expect(declaredEvents()).toEqual([]);
  });

  test("the runtime guard covers the PAYLOAD too — a shapeless declaration is refused at declare time", () => {
    // The same bypass reaches the other half of the contract (AD-21). Unguarded,
    // this declaration REGISTERED, and the first publish then threw
    // `TypeError: undefined is not an object (evaluating 'decl.payload.safeParse')`
    // from inside publish — an internal stack trace, surfacing in whichever
    // module published rather than in the one that mis-declared, and flatly
    // contradicting this module's own header ("enforced on every publish").
    expect(() =>
      declareEvents("probe", { "thing-happened": { deliveryClass: "human-facing" } as never }),
    ).toThrow(/no payload schema/);
    // Nothing was registered, so a publish gets the descriptive AD-21 error.
    expect(declaredEvents()).toEqual([]);
    expect(() => publish("probe:thing-happened", { id: "x" })).toThrow(/AD-21/);

    // A payload that is present but is not a schema is refused for the same
    // reason — the guard is "can this validate a publish", not "is the key set".
    expect(() =>
      declareEvents("probe", {
        "thing-happened": { deliveryClass: "agent-facing", payload: {} } as never,
      }),
    ).toThrow(/no payload schema/);

    // ...and a missing entry is NAMED rather than dereferenced.
    expect(() => declareEvents("probe", { "thing-happened": undefined as never })).toThrow(
      /is not a declaration/,
    );
    expect(declaredEvents()).toEqual([]);
  });
});

describe("AC3 — a name must be declared, and only by its own module", () => {
  test("AC3 subscribing to an undeclared event throws, naming the event and the rule", () => {
    declareFixtures();
    expect(() => subscribe("fixture:never-declared", () => {})).toThrow(
      /fixture:never-declared/,
    );
    expect(() => subscribe("fixture:never-declared", () => {})).toThrow(/AD-21/);
  });

  test("AC3 publishing an undeclared event throws too — a typo cannot mint a silent event", () => {
    declareFixtures();
    // Gating only the read side lets a publisher invent a name nobody can ever
    // subscribe to, which is a silent event rather than a loud mistake.
    expect(() => publish("fixture:nver-declared", { id: "x" })).toThrow(/fixture:nver-declared/);
    expect(() => publish("fixture:nver-declared", { id: "x" })).toThrow(/AD-21/);
  });

  test("a module cannot declare into another module's namespace — the name is composed, not supplied", () => {
    const port = declareEvents("mine", { "thing-happened": { deliveryClass: "human-facing", payload } });
    // The only name that exists is the one minted from the declaring module.
    expect(port.names["thing-happened"]).toBe("mine:thing-happened");
    expect(declaredEvents()).toEqual(["mine:thing-happened"]);
    // A fact carrying its own namespace is refused, so "yours:thing-happened"
    // is unreachable from a declareEvents("mine", ...) call by construction.
    expect(() =>
      declareEvents("mine", { "yours:thing-happened": { deliveryClass: "human-facing", payload } }),
    ).toThrow(/invalid event fact/);
    expect(declaredEvents()).toEqual(["mine:thing-happened"]);
    expect(eventDeclaration("yours:thing-happened")).toBeNull();
  });

  test("the module namespace itself is validated — no colons, no empties, no shouting", () => {
    for (const bad of ["", "Mine", "mine:sub", "9mine", "mine_thing", " mine"]) {
      expect(() =>
        declareEvents(bad, { "thing-happened": { deliveryClass: "human-facing", payload } }),
      ).toThrow(/invalid module namespace/);
    }
    expect(declaredEvents()).toEqual([]);
  });

  test("names follow <module>:<past-tense-fact> — the bus convention, not the NDJSON one", () => {
    const port = declareEvents("ultra", { "run-completed": { deliveryClass: "agent-facing", payload } });
    expect(port.names["run-completed"]).toBe("ultra:run-completed");
    // The older stream convention ("committed", "accept-aborted") is a bare
    // word with no namespace; it is a different, unrelated convention and is
    // not accepted here.
    expect(() =>
      declareEvents("loom", { committed: { deliveryClass: "agent-facing", payload } }),
    ).not.toThrow(); // a bare lower-kebab fact is fine...
    expect(declaredEvents()).toContain("loom:committed"); // ...it just gets namespaced.
  });

  test("re-declaring a name is an ERROR — the documented posture, asserted", () => {
    // The story leaves this call to the implementer: error, or idempotent
    // no-op. Chosen: ERROR. An event name is a published contract (AD-21), and
    // a second declaration is either a namespace collision or a payload shape
    // drifting — both must surface at wiring time, not at the first publish
    // that fails validation.
    declareFixtures();
    expect(() =>
      declareEvents("fixture", { "wake-worthy": { deliveryClass: "agent-facing", payload } }),
    ).toThrow(/already declared/);
    // And it is not silently partially applied: the original declaration stands.
    expect(eventDeclaration(AGENT_FACING)).toEqual({ deliveryClass: "agent-facing" });
  });
});

describe("AC2 — the class-gated wake channel", () => {
  test("AC2 an agent-facing publish reaches a wake-channel subscriber", () => {
    declareFixtures();
    const woke: unknown[] = [];
    subscribeAgentFacing(AGENT_FACING, (p) => woke.push(p));
    const r = publish(AGENT_FACING, { id: "a1" });
    expect(woke).toEqual([{ id: "a1" }]);
    expect(r.wakeDelivered).toBe(1);
    expect(r.deliveryClass).toBe("agent-facing");
  });

  test("AC2 registering a human-facing event on the wake channel is REFUSED", () => {
    declareFixtures();
    expect(() => subscribeAgentFacing(HUMAN_FACING, () => {})).toThrow(/wake channel/);
    expect(() => subscribeAgentFacing(HUMAN_FACING, () => {})).toThrow(/human-facing/);
  });

  test("AC2 a human-facing publish reaches ordinary subscribers and NEVER a wake handler", () => {
    declareFixtures();
    const seen: unknown[] = [];
    const woke: unknown[] = [];
    subscribe(HUMAN_FACING, (p) => seen.push(p));
    // A wake handler DOES exist on the bus — just on the other event — so this
    // is not vacuous: publish must not fan a human-facing event into the wake
    // channel at all.
    subscribeAgentFacing(AGENT_FACING, (p) => woke.push(p));

    const r = publish(HUMAN_FACING, { id: "h1" });
    expect(seen).toEqual([{ id: "h1" }]);
    expect(woke).toEqual([]);
    expect(r.delivered).toBe(1);
    expect(r.wakeDelivered).toBe(0);
  });

  test("AC2 canWake IS the gate — one rule, read by both the registration and the publish side", () => {
    // The filter both halves consult, asserted directly. MEASURED: replacing
    // canWake's body with `=> true` fails this test and the registration
    // refusal above — so the REGISTRATION side is the load-bearing guard.
    expect(canWake("agent-facing")).toBe(true);
    expect(canWake("human-facing")).toBe(false);
  });

  test("AC2 publish's own class gate is present and reads the same rule (defense in depth)", () => {
    // The publish-side half is unreachable by construction — a wake
    // subscription on a human-facing name cannot be created — so no behavioral
    // test can exercise it, and one that claimed to would be asserting nothing.
    // What CAN be pinned is that the branch exists and consults canWake, so a
    // later refactor cannot quietly drop it while the registration guard alone
    // carries the invariant.
    const source = fs.readFileSync(
      fileURLToPath(new URL("../src/event-bus.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("if (sub.wake && !wakeAllowed) continue;");
    expect(source).toContain("const wakeAllowed = canWake(decl.deliveryClass);");
  });

  test("declareEvents is ALL-OR-NOTHING — a malformed later entry registers none of the earlier ones", () => {
    // Partial application would leave a module unable to retry its own
    // declaration after fixing the typo: the good half would collide with
    // itself under the re-declaration rule.
    expect(() =>
      declareEvents("partial", {
        "first-happened": { deliveryClass: "agent-facing", payload },
        "SECOND:happened": { deliveryClass: "agent-facing", payload },
      }),
    ).toThrow(/invalid event fact/);
    expect(declaredEvents()).toEqual([]);
    // ...and the corrected catalogue declares cleanly on the retry.
    const port = declareEvents("partial", {
      "first-happened": { deliveryClass: "agent-facing", payload },
      "second-happened": { deliveryClass: "agent-facing", payload },
    });
    expect(declaredEvents()).toEqual(["partial:first-happened", "partial:second-happened"]);
    expect(port.names["second-happened"]).toBe("partial:second-happened");
  });
});

describe("delivery semantics", () => {
  test("a throwing subscriber neither breaks publish nor starves its siblings", () => {
    // Posture, documented in-source and asserted here: delivery is a fan-out,
    // not a transaction. The failure is COUNTED rather than swallowed silently,
    // so a publisher can see it without a side channel.
    declareFixtures();
    const seen: string[] = [];
    subscribe(HUMAN_FACING, () => seen.push("first"));
    subscribe(HUMAN_FACING, () => {
      throw new Error("subscriber blew up");
    });
    subscribe(HUMAN_FACING, () => seen.push("third"));

    let r!: ReturnType<typeof publish>;
    expect(() => {
      r = publish(HUMAN_FACING, { id: "h" });
    }).not.toThrow();
    expect(seen).toEqual(["first", "third"]);
    expect(r.delivered).toBe(2);
    expect(r.failed).toBe(1);
  });

  test("unsubscribe stops delivery", () => {
    declareFixtures();
    const seen: string[] = [];
    const off = subscribe(HUMAN_FACING, () => seen.push("x"));
    publish(HUMAN_FACING, { id: "1" });
    off();
    publish(HUMAN_FACING, { id: "2" });
    expect(seen).toEqual(["x"]);
    // Unsubscribing twice is harmless.
    expect(() => off()).not.toThrow();
  });

  test("a handler that unsubscribes DURING delivery does not shift the list being walked", () => {
    // The subscriber list is copied before the fan-out. Without the copy, the
    // second handler's removal makes the iteration skip the third.
    declareFixtures();
    const seen: string[] = [];
    subscribe(HUMAN_FACING, () => seen.push("a"));
    const off = subscribe(HUMAN_FACING, () => {
      seen.push("b");
      off();
    });
    subscribe(HUMAN_FACING, () => seen.push("c"));
    const r = publish(HUMAN_FACING, { id: "1" });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(r.delivered).toBe(3);
    // ...and it really did unsubscribe.
    publish(HUMAN_FACING, { id: "2" });
    expect(seen).toEqual(["a", "b", "c", "a", "c"]);
  });

  test("the payload is validated against the declared shape (AD-21) and a mismatch throws", () => {
    declareFixtures();
    expect(() => publish(HUMAN_FACING, { id: 7 })).toThrow(/does not match its declared shape/);
    expect(() => publish(HUMAN_FACING, {})).toThrow(/AD-21/);
    expect(() => publish(HUMAN_FACING, { id: "ok" })).not.toThrow();
  });

  test("a publish with no subscribers is a no-op that still reports the class", () => {
    declareFixtures();
    const r = publish(AGENT_FACING, { id: "z" });
    expect(r).toEqual({
      name: AGENT_FACING,
      deliveryClass: "agent-facing",
      delivered: 0,
      wakeDelivered: 0,
      failed: 0,
    });
  });

  test("the typed port composes every name it publishes and subscribes", () => {
    const port = declareEvents("typed", {
      "thing-happened": { deliveryClass: "agent-facing", payload: z.object({ n: z.number() }) },
    });
    const seen: Array<{ n: number }> = [];
    port.subscribeAgentFacing("thing-happened", (p) => seen.push(p));
    port.publish("thing-happened", { n: 3 });
    expect(seen).toEqual([{ n: 3 }]);
    expect(port.module).toBe("typed");
    expect(port.names["thing-happened"]).toBe("typed:thing-happened");
  });
});

describe("resetBus and the in-process-only scope", () => {
  test("resetBus clears declarations AND subscriptions", () => {
    declareFixtures();
    const seen: string[] = [];
    subscribe(HUMAN_FACING, () => seen.push("x"));
    expect(declaredEvents()).toEqual([HUMAN_FACING, AGENT_FACING].sort());

    resetBus();
    expect(declaredEvents()).toEqual([]);
    expect(() => publish(HUMAN_FACING, { id: "1" })).toThrow(/no module declared it/);

    // Re-declaring after a reset works, and the old subscription is gone.
    declareFixtures();
    publish(HUMAN_FACING, { id: "1" });
    expect(seen).toEqual([]);
  });

  test("T-1 the bus persists NOTHING — a busy publish leaves the state root empty", () => {
    declareFixtures();
    subscribe(HUMAN_FACING, () => {});
    subscribeAgentFacing(AGENT_FACING, () => {});
    for (let i = 0; i < 50; i++) {
      publish(HUMAN_FACING, { id: `h${i}` });
      publish(AGENT_FACING, { id: `a${i}` });
    }
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("T-1 the bus does not touch the filesystem at all — asserted against its own source", () => {
    // The tempting design (derive events by watching the state tree) is
    // forbidden twice over: a watcher reads every module's subtree by path,
    // inverting AD-5/AD-20, and fs-watch semantics differ between the Next dev
    // server and the packaged Electron app. A behavioral test can only show
    // that today's code paths wrote nothing; this shows the capability is not
    // even imported. Same instrument state-root.test.ts uses, with the same
    // honest limit: it matches text.
    const source = fs.readFileSync(
      fileURLToPath(new URL("../src/event-bus.ts", import.meta.url)),
      "utf8",
    );
    // Comments are stripped first — the header talks ABOUT fs.watch precisely
    // to say the bus must never use it, and a scan that cannot tell prose from
    // code would fail on its own documentation.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const forbidden = [
      "node:fs",
      'from "fs"',
      "fs.watch",
      "watchFile",
      "appendFileSync",
      "writeFileSync",
      "renameSync",
      "mkdirSync",
    ];
    expect(forbidden.filter((f) => code.includes(f))).toEqual([]);
    // Floors, so a scan whose target moved cannot pass by matching nothing.
    expect(code).toContain("export function publish");
    expect(source).toContain("fs.watch"); // ...the header really does discuss it
  });
});
