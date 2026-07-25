// Story 1.1 / CAP-1 — TELAR_HOME isolation for the chat + usage + plan stores.
//
// The point of this file is AC1's "asserted by a test, not by inspection": the
// real ~/.telar must be provably untouched by a TELAR_HOME-scoped run. It is
// proven by CONTENT hash, not by existence — store.ts's failure mode was an
// APPEND to an already-existing usage.ndjson, which an existence check cannot
// see. Nothing here ever writes into the real home.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Point the stores at a throwaway dir BEFORE importing the module — stateRoot()
// reads process.env lazily, so a static import would be fine too (permissions.test.ts
// idiom); the dynamic import keeps the ordering explicit.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-"));
process.env.TELAR_HOME = TMP;
// bun test runs all files in one process — re-pin the env before every test.
beforeEach(() => {
  process.env.TELAR_HOME = TMP;
});

const store = await import("./store");

const REAL_HOME = path.join(os.homedir(), ".telar");

// {exists, sha256} of the real home's three files. Read-only: never creates the
// directory, never stats into existence. Existence alone is not enough — an
// append to an already-present usage.ndjson leaves existence unchanged.
function realHomeFingerprint() {
  const snap: Record<string, string> = {};
  for (const name of ["chats.json", "usage.ndjson", "plan-usage.json"]) {
    const file = path.join(REAL_HOME, name);
    try {
      snap[name] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch {
      snap[name] = "<absent>";
    }
  }
  return snap;
}

function ledgerLine(over: Record<string, unknown> = {}) {
  return {
    ts: Date.now(),
    account: "personal",
    model: "sonnet",
    sessionId: "s1",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0.25,
    ...over,
  };
}

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("store TELAR_HOME isolation (CAP-1)", () => {
  test("TELAR_HOME isolates chats.json, usage.ndjson and plan-usage.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-ac1-"));
    process.env.TELAR_HOME = root;
    try {
      store.upsertChatStub({
        id: "ac1-session",
        model: "sonnet",
        account: "personal",
        userText: "hello",
      });
      store.logUsage(ledgerLine({ sessionId: "ac1-session" }));
      store.savePlanUsage("personal", { subscriptionType: "max" });

      expect(fs.existsSync(path.join(root, "chats.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "usage.ndjson"))).toBe(true);
      expect(fs.existsSync(path.join(root, "plan-usage.json"))).toBe(true);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("stateRoot() is TELAR_HOME when it is set", () => {
    expect(store.stateRoot()).toBe(TMP);
  });

  test("the real ~/.telar is unchanged in CONTENT by a TELAR_HOME-scoped run", () => {
    const before = realHomeFingerprint();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-ac1b-"));
    process.env.TELAR_HOME = root;
    try {
      store.upsertChatStub({
        id: "untouched-session",
        model: "sonnet",
        account: "personal",
        userText: "hi",
      });
      store.logUsage(ledgerLine({ sessionId: "untouched-session" }));
      store.savePlanUsage("personal", { subscriptionType: "pro" });
      store.listChats();
      store.usageSummary();
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(realHomeFingerprint()).toEqual(before);
  });

  test("with TELAR_HOME unset, stateRoot() falls back to <homedir>/.telar", () => {
    const saved = process.env.TELAR_HOME;
    try {
      delete process.env.TELAR_HOME;
      expect(store.stateRoot()).toBe(path.join(os.homedir(), ".telar"));
    } finally {
      process.env.TELAR_HOME = saved;
    }
  });

  test("with TELAR_HOME unset, a write lands under the inherited HOME", () => {
    // os.homedir() under Bun is resolved at process start and ignores an
    // in-process process.env.HOME write — only an INHERITED HOME is honored.
    // So the unset-TELAR_HOME WRITE branch can only be exercised in a child
    // process, which also keeps the real ~/.telar out of the candidate set.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-home-"));
    const storePath = fileURLToPath(new URL("./store.ts", import.meta.url));
    const probe = path.join(fakeHome, "probe.ts");
    fs.writeFileSync(
      probe,
      [
        `const store = await import(${JSON.stringify(storePath)});`,
        `store.logUsage({ ts: Date.now(), account: "a", model: "m", sessionId: "s",`,
        `  inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 1 });`,
        `console.log(store.stateRoot());`,
      ].join("\n"),
    );
    // NODE_ENV=production because this child stands in for the packaged server
    // / dev process, not a test: the ledger port deliberately refuses to write
    // with NODE_ENV=test and no TELAR_HOME (that guard is covered separately).
    const env = { ...process.env, HOME: fakeHome, NODE_ENV: "production" as const };
    delete (env as Record<string, string | undefined>).TELAR_HOME;
    const out = spawnSync(process.execPath, [probe], { env, encoding: "utf8" });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(fs.existsSync(path.join(fakeHome, ".telar", "usage.ndjson"))).toBe(true);
    // The parent's own root is untouched by the child.
    expect(fs.existsSync(path.join(TMP, ".telar"))).toBe(false);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("a dev root and a smoke root in one process stay distinct", () => {
    // The --smoke gate (apps/desktop/main.js) forks the packaged server with
    // TELAR_HOME pointed at a mkdtemp'd throwaway home; the dev script defaults
    // it to ~/.telar-dev. Both must hold their own state. Before CAP-1 they
    // silently shared ~/.telar.
    const dev = fs.mkdtempSync(path.join(os.tmpdir(), "telar-dev-"));
    const smoke = fs.mkdtempSync(path.join(os.tmpdir(), "telar-smoke-"));
    try {
      process.env.TELAR_HOME = dev;
      store.upsertChatStub({ id: "dev-chat", model: "sonnet", account: "personal", userText: "d" });
      store.logUsage(ledgerLine({ sessionId: "dev-chat", costUsd: 1 }));

      process.env.TELAR_HOME = smoke;
      store.upsertChatStub({ id: "smoke-chat", model: "sonnet", account: "personal", userText: "s" });
      store.logUsage(ledgerLine({ sessionId: "smoke-chat", costUsd: 2 }));

      const devChats = JSON.parse(fs.readFileSync(path.join(dev, "chats.json"), "utf8"));
      const smokeChats = JSON.parse(fs.readFileSync(path.join(smoke, "chats.json"), "utf8"));
      expect(devChats.chats.map((c: { id: string }) => c.id)).toEqual(["dev-chat"]);
      expect(smokeChats.chats.map((c: { id: string }) => c.id)).toEqual(["smoke-chat"]);

      const devLedger = fs.readFileSync(path.join(dev, "usage.ndjson"), "utf8");
      const smokeLedger = fs.readFileSync(path.join(smoke, "usage.ndjson"), "utf8");
      expect(devLedger).toContain("dev-chat");
      expect(devLedger).not.toContain("smoke-chat");
      expect(smokeLedger).toContain("smoke-chat");
      expect(smokeLedger).not.toContain("dev-chat");
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(dev, { recursive: true, force: true });
      fs.rmSync(smoke, { recursive: true, force: true });
    }
  });

  test("the ledger read cache does not leak across TELAR_HOME roots", () => {
    // getChat's tokensFromUsageLog path is memoized. Keyed on mtime alone, root
    // B could serve root A's parsed map whenever the two ledgers' mtimes agree.
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "telar-root-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "telar-root-b-"));
    try {
      const chat = {
        id: "shared-id",
        title: "t",
        model: "sonnet",
        account: "personal",
        createdAt: 1,
        updatedAt: 1,
        costUsd: 0,
        turns: 1,
        messages: [],
      };
      for (const root of [a, b]) {
        fs.writeFileSync(path.join(root, "chats.json"), JSON.stringify({ chats: [chat] }));
      }
      const line = (inputTokens: number) =>
        JSON.stringify(ledgerLine({ sessionId: "shared-id", inputTokens })) + "\n";
      fs.writeFileSync(path.join(a, "usage.ndjson"), line(111));
      fs.writeFileSync(path.join(b, "usage.ndjson"), line(222));
      // Force identical mtimes — the exact coincidence an mtime-only key misses.
      const when = new Date(1_700_000_000_000);
      fs.utimesSync(path.join(a, "usage.ndjson"), when, when);
      fs.utimesSync(path.join(b, "usage.ndjson"), when, when);

      process.env.TELAR_HOME = a;
      expect(store.getChat("shared-id")!.inputTokens).toBe(111);
      process.env.TELAR_HOME = b;
      expect(store.getChat("shared-id")!.inputTokens).toBe(222);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("session spend is a projection over usage.ndjson (CAP-2, AC6a)", () => {
  // Writes a chat row straight into chats.json so the STORED counter can be
  // poisoned with a value the ledger contradicts — a read that falls back to
  // the counter then fails loudly instead of passing by coincidence.
  function seedChat(root: string, id: string, costUsd: number) {
    fs.writeFileSync(
      path.join(root, "chats.json"),
      JSON.stringify({
        chats: [
          {
            id,
            title: "t",
            model: "sonnet",
            account: "personal",
            createdAt: 1,
            updatedAt: 1,
            costUsd,
            turns: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            messages: [],
          },
        ],
      }),
    );
  }

  function projectionRoot(tag: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-store-${tag}-`));
    process.env.TELAR_HOME = root;
    return root;
  }

  test("getChat's costUsd is the ledger sum, not the stored chat counter", () => {
    const root = projectionRoot("proj");
    try {
      seedChat(root, "chat-1", 999); // poisoned counter
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 1 }));
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 0.5 }));
      expect(store.getChat("chat-1")!.costUsd).toBe(1.5);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("getChat's costUsd excludes ultra spend that rode the same sessionId", () => {
    // An ultra run's ledger lines legitimately carry the OWNING chat's
    // sessionId. They are the run's spend, not the chat's.
    const root = projectionRoot("owner");
    try {
      seedChat(root, "chat-1", 999);
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 1 }));
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 0.5 }));
      store.logUsage(
        ledgerLine({ sessionId: "chat-1", ownerKind: "ultra", ownerId: "run_x", costUsd: 5 }),
      );
      expect(store.getChat("chat-1")!.costUsd).toBe(1.5);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("listChats' costUsd is the ledger sum, not the stored chat counter", () => {
    // The two read surfaces must not be able to disagree.
    const root = projectionRoot("list");
    try {
      seedChat(root, "chat-1", 999);
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 2.25 }));
      expect(store.listChats().find((c) => c.id === "chat-1")!.costUsd).toBe(2.25);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a ledger line appended out-of-band changes the next getChat read", () => {
    // An independent counter is structurally incapable of passing this.
    const root = projectionRoot("oob");
    try {
      seedChat(root, "chat-1", 0);
      store.logUsage(ledgerLine({ sessionId: "chat-1", costUsd: 1 }));
      expect(store.getChat("chat-1")!.costUsd).toBe(1);
      fs.appendFileSync(
        path.join(root, "usage.ndjson"),
        JSON.stringify(ledgerLine({ sessionId: "chat-1", costUsd: 3 })) + "\n",
      );
      expect(store.getChat("chat-1")!.costUsd).toBe(4);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("sessionSpendUsd — the LIVE readout's source — is a projection, not a counter", () => {
    // The chat route reads this after appending the turn's ledger line and
    // broadcasts it on "done"; the session view sets it rather than adding a
    // delta. So the live per-turn display folds the same log the persisted
    // read does, and an out-of-band line moves it. A counter cannot.
    const root = projectionRoot("live");
    try {
      seedChat(root, "chat-live", 999); // poisoned counter
      store.logUsage(ledgerLine({ sessionId: "chat-live", costUsd: 1 }));
      expect(store.sessionSpendUsd("chat-live")).toBe(1);
      fs.appendFileSync(
        path.join(root, "usage.ndjson"),
        JSON.stringify(ledgerLine({ sessionId: "chat-live", costUsd: 2.5 })) + "\n",
      );
      expect(store.sessionSpendUsd("chat-live")).toBe(3.5);
      // Same fold the persisted surface uses — the live and reload readouts
      // cannot disagree, which is the whole point of one ledger.
      expect(store.getChat("chat-live")!.costUsd).toBe(3.5);
      // An ultra line riding this chat's sessionId is that run's spend.
      store.logUsage(
        ledgerLine({ sessionId: "chat-live", ownerKind: "ultra", ownerId: "run_y", costUsd: 9 }),
      );
      expect(store.sessionSpendUsd("chat-live")).toBe(3.5);
      expect(store.sessionSpendUsd("no-such-session")).toBe(0);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a usage line written before owner attribution counts toward getChat and usageSummary and never throws", () => {
    const root = projectionRoot("historical");
    try {
      seedChat(root, "chat-1", 0);
      // Hand-written in the pre-attribution shape: no ownerKind, no ownerId.
      fs.appendFileSync(
        path.join(root, "usage.ndjson"),
        JSON.stringify({
          ts: Date.now(),
          account: "personal",
          model: "sonnet",
          sessionId: "chat-1",
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 6,
        }) + "\n",
      );
      expect(() => store.getChat("chat-1")).not.toThrow();
      expect(store.getChat("chat-1")!.costUsd).toBe(6);
      expect(store.usageSummary().weekly.costUsd).toBe(6);
      expect(store.usageSummary().weekly.requests).toBe(1);
    } finally {
      process.env.TELAR_HOME = TMP;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
