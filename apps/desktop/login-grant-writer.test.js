// The mirror is pinned to the original: these tests run the shell's writer
// against the ENGINE'S OWN STORE (bun resolves the TypeScript module
// directly), including under real cross-process lock contention. A grant the
// shell writes must be a grant the daemon lists and the worker's fill
// matches, or this suite fails before a user's fill does. Metadata only.
const { describe, expect, test } = require("bun:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { rememberLoginGrant, exactOrigin, LOGIN_GRANTS_FILE, LOGIN_GRANTS_VERSION } = require("./login-grant-writer");
const engine = require("../engine/src/secrets/login-grants.ts");

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "telar-login-grants-"));

const input = (over = {}) => ({
  profileId: "profile_1",
  profileLabel: "Personal",
  origin: "https://accounts.example.com",
  itemId: "item_a",
  itemTitle: "Example — work",
  vault: "Private",
  fields: [{ kind: "username" }, { kind: "password" }],
  ...over,
});

describe("the shell's writer against the engine's store", () => {
  test("the constants are the engine's constants", () => {
    expect(LOGIN_GRANTS_FILE).toBe(engine.LOGIN_GRANTS_FILE);
    expect(LOGIN_GRANTS_VERSION).toBe(engine.LOGIN_GRANTS_VERSION);
  });

  test("a grant the shell writes is a grant the engine finds", async () => {
    const root = tempRoot();
    const written = await rememberLoginGrant(root, input(), { now: () => 42, mintId: () => "lg_test" });
    const store = engine.createLoginGrantStore(root);
    expect(store.list()).toEqual([
      {
        id: "lg_test",
        profileId: "profile_1",
        profileLabel: "Personal",
        origin: "https://accounts.example.com",
        itemId: "item_a",
        itemTitle: "Example — work",
        vault: "Private",
        fields: [{ kind: "username" }, { kind: "password" }],
        createdAt: 42,
      },
    ]);
    // The exact lookup the worker's fill makes on the remembered path.
    expect(
      store.find({
        profileId: "profile_1",
        origin: "https://accounts.example.com",
        itemId: "item_a",
        wants: [{ kind: "username" }, { kind: "password" }],
      })?.id,
    ).toBe(written.id);
  });

  test("the shell preserves grants the engine wrote, and the replace rule is shared", async () => {
    const root = tempRoot();
    const store = engine.createLoginGrantStore(root, { now: () => 1, mintId: () => "lg_engine" });
    store.remember({
      profileId: "profile_1",
      origin: "https://accounts.example.com",
      itemId: "item_engine",
      itemTitle: "engine's",
      fields: [{ kind: "password" }],
    });
    // A different item on the same origin ADDS (two accounts, two grants)…
    await rememberLoginGrant(root, input({ itemId: "item_b", itemTitle: "second account" }));
    // …and re-approving the SAME (profile, origin, item) REPLACES.
    await rememberLoginGrant(root, input({ itemId: "item_engine", itemTitle: "re-approved" }));
    const titles = store.list().map((grant) => [grant.itemId, grant.itemTitle]).sort();
    expect(titles).toEqual([
      ["item_b", "second account"],
      ["item_engine", "re-approved"],
    ]);
  });

  test("otp rides along when the person allowed it", async () => {
    const root = tempRoot();
    await rememberLoginGrant(root, input({ fields: [{ kind: "username" }, { kind: "password" }, { kind: "otp" }] }));
    expect(
      engine.createLoginGrantStore(root).find({
        profileId: "profile_1",
        origin: "https://accounts.example.com",
        itemId: "item_a",
        wants: [{ kind: "otp" }],
      }),
    ).not.toBeNull();
  });

  test("the file is private to the user", async () => {
    const root = tempRoot();
    await rememberLoginGrant(root, input());
    expect(fs.statSync(path.join(root, LOGIN_GRANTS_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe("the shared lock, against the engine's protocol", () => {
  test("a live lock makes the writer WAIT (without blocking the event loop), not fail", async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, `${LOGIN_GRANTS_FILE}.lock`);
    fs.mkdirSync(lock); // another process, mid-mutation
    let settled = false;
    const pending = rememberLoginGrant(root, input()).finally(() => (settled = true));
    await delay(120); // several retry beats — the event loop is visibly free
    expect(settled).toBe(false);
    fs.rmdirSync(lock); // the holder finishes
    await pending;
    expect(engine.createLoginGrantStore(root).list().length).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("a stale lock (dead holder) is broken, as the engine breaks it", async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, `${LOGIN_GRANTS_FILE}.lock`);
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await rememberLoginGrant(root, input());
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("REAL contention with the engine store loses no update in either direction", async () => {
    // The engine's synchronous store hammers the file from a SEPARATE bun
    // process while the shell's async writer hammers it from this one. Every
    // grant is distinct, so any lost read-modify-write shows as a missing row.
    const root = tempRoot();
    const modulePath = path.join(__dirname, "..", "engine", "src", "secrets", "login-grants.ts");
    const script = `
      const { createLoginGrantStore } = require(process.env.MODULE);
      const store = createLoginGrantStore(process.env.ROOT);
      for (let i = 0; i < 20; i += 1) {
        store.remember({ profileId: "p", origin: "https://contend.example.com", itemId: "engine_" + i, itemTitle: "engine " + i, fields: [{ kind: "password" }] });
      }
    `;
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, MODULE: modulePath, ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const childDone = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`engine-store child exited ${code}: ${stderr}`))));
    });
    for (let i = 0; i < 20; i += 1) {
      await rememberLoginGrant(root, input({ origin: "https://contend.example.com", profileId: "p", itemId: `shell_${i}`, itemTitle: `shell ${i}` }));
    }
    await childDone;
    const ids = engine.createLoginGrantStore(root).list().map((grant) => grant.itemId).sort();
    expect(ids).toEqual(
      [...Array(20).keys()].flatMap((i) => [`engine_${i}`, `shell_${i}`]).sort(),
    );
  }, 20_000);
});

describe("what the writer refuses", () => {
  test("a non-origin, a missing item, empty fields, a missing profile", async () => {
    const root = tempRoot();
    expect(rememberLoginGrant(root, input({ origin: "file:///etc/passwd" }))).rejects.toThrow("exact http(s) origin");
    expect(rememberLoginGrant(root, input({ itemId: "" }))).rejects.toThrow("1Password item");
    expect(rememberLoginGrant(root, input({ fields: [] }))).rejects.toThrow("fields");
    expect(rememberLoginGrant(root, input({ profileId: "" }))).rejects.toThrow("browser profile");
    // A full URL is reduced to its origin on write, same as the engine.
    const grant = await rememberLoginGrant(root, input({ origin: "https://accounts.example.com/signin?next=/inbox" }));
    expect(grant.origin).toBe("https://accounts.example.com");
  });

  test("exactOrigin agrees with the engine's", () => {
    for (const value of ["https://a.example.com/x", "http://localhost:3000", "chrome://settings", "not a url", "ftp://x.com"]) {
      expect(exactOrigin(value)).toBe(engine.exactOrigin(value));
    }
  });

  test("an unreadable file authorizes nothing and is not resurrected", async () => {
    const root = tempRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, LOGIN_GRANTS_FILE), "{ not json");
    await rememberLoginGrant(root, input(), { mintId: () => "lg_only" });
    expect(engine.createLoginGrantStore(root).list().map((grant) => grant.id)).toEqual(["lg_only"]);
  });
});
