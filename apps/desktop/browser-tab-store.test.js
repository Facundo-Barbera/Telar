const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { createTabStore, serializeInventory, parseInventory, rememberableUrl, INVENTORY_VERSION } = require("./browser-tab-store");

const { ProfileRegistry } = require("./browser-profiles");

const PROJECT = "project_0123456789abcdef0123456789abcdef";
const OTHER = "project_fedcba9876543210fedcba9876543210";

/**
 * An ephemeral registry with predictable ids — the resolution the manager would
 * do at restore, without a shell or a file.
 *
 * THE COUNTER STARTS BELOW ZERO because opening a registry mints its "Default"
 * profile (browser-profiles.js `ensureDefault`), and that one takes the first id.
 * Starting at -1 leaves `bp_…0001` for the first profile a test creates, so P1/P2
 * below keep meaning "the first and second profiles this test made".
 */
function registry(existingPartitions = []) {
  let next = -1;
  const onDisk = new Set(existingPartitions);
  return new ProfileRegistry(null, {
    randomId: () => `bp_${String(++next).padStart(16, "0")}`,
    now: () => next,
    partitionExists: (partition) => onDisk.has(partition),
  });
}

const P1 = "bp_0000000000000001";
const P2 = "bp_0000000000000002";

function inventory(tabs, { profiles, projects, overrides, active } = {}) {
  return serializeInventory({
    tabs,
    profiles: new Map(profiles ?? [["s1", P1]]),
    projects: new Map(projects ?? [["s1", PROJECT]]),
    overrides: new Map(overrides ?? []),
    active: new Map(active ?? []),
  });
}

describe("what the inventory remembers", () => {
  test("scoped metadata only: id, url, title, opener, viewport, order, active — never an extension page or a non-web URL", () => {
    const doc = inventory(
      [
        { scopeKey: "s1", id: "a", url: "https://one.example/", title: "One", openedBy: "human", viewport: { width: 390, height: 844 } },
        { scopeKey: "s1", id: "popup", url: "chrome-extension://abc/popup.html", title: "1Password", openedBy: "human" },
        { scopeKey: "s1", id: "b", url: "about:blank", title: "New tab", openedBy: "agent", console: ["secret"], refs: new Map() },
        { scopeKey: "s1", id: "c", url: "file:///etc/passwd", title: "nope", openedBy: "agent" },
      ],
      { active: [["s1", "b"]] },
    );
    expect(doc.version).toBe(INVENTORY_VERSION);
    expect(doc.scopes.s1).toEqual({
      profileId: P1,
      projectKey: PROJECT,
      activeTabId: "b",
      tabs: [
        { id: "a", url: "https://one.example/", title: "One", openedBy: "human", viewport: { width: 390, height: 844 } },
        { id: "b", url: "about:blank", title: "New tab", openedBy: "agent" },
      ],
    });
    expect(JSON.stringify(doc)).not.toContain("secret");
    expect(JSON.stringify(doc)).not.toContain("chrome-extension");
  });

  test("a scope with no declared profile is not remembered — nothing may guess its jar later", () => {
    const doc = inventory([{ scopeKey: "unbound", id: "a", url: "https://x.example/", title: "x", openedBy: "agent" }], { profiles: [] });
    expect(doc.scopes).toEqual({});
  });

  test("the active id falls back to the last remembered tab when the active one was an extension page", () => {
    const doc = inventory(
      [
        { scopeKey: "s1", id: "a", url: "https://one.example/", title: "One", openedBy: "agent" },
        { scopeKey: "s1", id: "ext", url: "chrome-extension://abc/x.html", title: "x", openedBy: "human" },
      ],
      { active: [["s1", "ext"]] },
    );
    expect(doc.scopes.s1.activeTabId).toBe("a");
  });

  test("rememberableUrl keeps http(s) and about:blank only", () => {
    expect(rememberableUrl("https://a.example/p?q=1")).toBe("https://a.example/p?q=1");
    expect(rememberableUrl("about:blank")).toBe("about:blank");
    expect(rememberableUrl("")).toBe("about:blank");
    expect(rememberableUrl("chrome-extension://abc/x.html")).toBeNull();
    expect(rememberableUrl("javascript:alert(1)")).toBeNull();
    expect(rememberableUrl("not a url")).toBeNull();
  });
});

describe("what a restore accepts", () => {
  test("round-trips a serialized document", () => {
    const doc = inventory(
      [
        { scopeKey: "s1", id: "a", url: "https://one.example/", title: "One", openedBy: "human" },
        { scopeKey: "s1", id: "b", url: "https://two.example/", title: "Two", openedBy: "agent", viewport: { width: 768, height: 1024 } },
        { scopeKey: "s2", id: "c", url: "https://three.example/", title: "Three", openedBy: "agent" },
      ],
      {
        profiles: [["s1", P1], ["s2", P2]],
        projects: [["s1", PROJECT], ["s2", "none"]],
        active: [["s1", "a"], ["s2", "c"]],
      },
    );
    const store = registry();
    const one = store.create({ label: "One" });
    const two = store.create({ label: "Two" });
    expect([one.id, two.id]).toEqual([P1, P2]);
    const scopes = parseInventory(JSON.parse(JSON.stringify(doc)), store);
    expect(scopes).toEqual([
      {
        scopeKey: "s1",
        profile: store.get(P1),
        projectKey: PROJECT,
        overridden: false,
        activeTabId: "a",
        tabs: [
          { id: "a", url: "https://one.example/", title: "One", openedBy: "human" },
          { id: "b", url: "https://two.example/", title: "Two", openedBy: "agent", viewport: { width: 768, height: 1024 } },
        ],
      },
      {
        scopeKey: "s2",
        profile: store.get(P2),
        projectKey: "none",
        overridden: false,
        activeTabId: "c",
        tabs: [{ id: "c", url: "https://three.example/", title: "Three", openedBy: "agent" }],
      },
    ]);
  });

  test("a v1 inventory restores through the profile ladder, onto the cookie jar its project already had", () => {
    // The jar is ON DISK, which is the whole migration signal: the ladder adopts
    // that exact partition rather than landing the scope in the default.
    const store = registry([`persist:telar-project-${PROJECT.slice("project_".length)}`]);
    const scopes = parseInventory(
      {
        version: 1,
        scopes: {
          s1: { profileKey: PROJECT, activeTabId: "a", tabs: [{ id: "a", url: "https://one.example/", title: "One" }] },
          s2: { profileKey: "not-a-project", tabs: [{ id: "b", url: "https://two.example/" }] },
        },
      },
      store,
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0].projectKey).toBe(PROJECT);
    // The partition is EXACTLY the pre-profile one: nothing was copied.
    expect(scopes[0].profile.partition).toBe(`persist:telar-project-${PROJECT.slice("project_".length)}`);
    // And the ladder recorded the metadata move for the caches that follow it.
    expect(store.migrations).toEqual([{ from: PROJECT, to: scopes[0].profile.id }]);
  });

  test("a scope whose profile the registry no longer has is dropped, never rehomed", () => {
    const store = registry();
    store.create({ label: "Kept" });
    const scopes = parseInventory(
      {
        version: INVENTORY_VERSION,
        scopes: {
          kept: { profileId: P1, activeTabId: "a", tabs: [{ id: "a", url: "https://kept.example/" }] },
          dangling: { profileId: "bp_00000000000000ff", tabs: [{ id: "b", url: "https://gone.example/" }] },
        },
      },
      store,
    );
    expect(scopes.map((scope) => scope.scopeKey)).toEqual(["kept"]);
  });

  test("a tab remembers its own profile, so a session that switched identities comes back with both", () => {
    const store = registry();
    store.create({ label: "One" });
    store.create({ label: "Two" });
    const doc = inventory(
      [
        { scopeKey: "s1", id: "old", url: "https://one.example/", title: "One", openedBy: "human", profileId: P1 },
        { scopeKey: "s1", id: "new", url: "https://two.example/", title: "Two", openedBy: "agent", profileId: P2 },
        { scopeKey: "s1", id: "gone", url: "https://three.example/", title: "Three", openedBy: "agent", profileId: "bp_00000000000000ff" },
      ],
      { profiles: [["s1", P2]], overrides: [["s1", P2]] },
    );
    const scopes = parseInventory(JSON.parse(JSON.stringify(doc)), store);
    expect(scopes[0].overridden).toBe(true);
    expect(scopes[0].profile.id).toBe(P2);
    expect(scopes[0].tabs.map((tab) => tab.profileId)).toEqual([P1, P2, undefined]);
  });

  test("a hand-edited file cannot smuggle an extension page, a duplicate id, a bad viewport, or an unmappable profile", () => {
    const store = registry();
    store.create({ label: "One" });
    store.create({ label: "Two" });
    const scopes = parseInventory(
      {
        version: INVENTORY_VERSION,
        scopes: {
          good: {
            profileId: P1,
            activeTabId: "zzz",
            tabs: [
              { id: "a", url: "chrome-extension://abc/unlock.html", title: "Unlock" },
              { id: "b", url: "https://ok.example/", title: "ok", viewport: { width: 10, height: 10 } },
              { id: "b", url: "https://dup.example/", title: "dup" },
              "garbage",
              { id: "", url: "https://noid.example/" },
            ],
          },
          legacyGrab: { profileId: "legacy", tabs: [{ id: "x", url: "https://x.example/" }] },
          wrongShape: { profileId: P2, tabs: [{ id: "y", url: "https://y.example/" }] },
          "": { profileId: P2, tabs: [{ id: "z", url: "https://z.example/" }] },
        },
      },
      store,
    );
    expect(scopes).toEqual([
      { scopeKey: "good", profile: store.get(P1), overridden: false, activeTabId: "b", tabs: [{ id: "b", url: "https://ok.example/", title: "ok", openedBy: "agent" }] },
      { scopeKey: "wrongShape", profile: store.get(P2), overridden: false, activeTabId: "y", tabs: [{ id: "y", url: "https://y.example/", title: "New tab", openedBy: "agent" }] },
    ]);
  });

  test("an unknown version, a null document, or a non-object is nothing to restore", () => {
    const store = registry();
    expect(parseInventory(null, store)).toEqual([]);
    expect(parseInventory({ version: 99, scopes: { s: { profileId: P1, tabs: [{ id: "a", url: "https://a.example/" }] } } }, store)).toEqual([]);
    expect(parseInventory("nonsense", store)).toEqual([]);
  });
});

describe("the on-disk store", () => {
  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "telar-tab-store-"));
  }

  test("writes atomically, coalesces to the latest document, and reads it back", async () => {
    const dir = tmp();
    const store = createTabStore(dir, { writeDelayMs: 5 });
    expect(store.load()).toBeNull();
    store.save({ version: INVENTORY_VERSION, savedAt: 1, scopes: { s: { profileKey: PROJECT, activeTabId: "a", tabs: [{ id: "a", url: "https://a.example/" }] } } });
    // A tab closed before the debounce fires is gone from the write — the
    // latest document wins; the earlier one is never written.
    store.save({ version: INVENTORY_VERSION, savedAt: 2, scopes: {} });
    await store.flush();
    expect(store.load()).toEqual({ version: INVENTORY_VERSION, savedAt: 2, scopes: {} });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a save during an in-flight write is written after it, never lost", async () => {
    const dir = tmp();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowFs = {
      ...fs,
      promises: {
        ...fs.promises,
        writeFile: async (...args) => { await gate; return fs.promises.writeFile(...args); },
      },
    };
    const store = createTabStore(dir, { fsImpl: slowFs, writeDelayMs: 0 });
    store.save({ version: INVENTORY_VERSION, savedAt: 1, scopes: {} });
    const first = store.flush();
    store.save({ version: INVENTORY_VERSION, savedAt: 2, scopes: {} });
    release();
    await first;
    await store.flush();
    expect(store.load().savedAt).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an older async write that completes AFTER flushSync cannot overwrite the newer inventory", async () => {
    const dir = tmp();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowFs = {
      ...fs,
      promises: {
        ...fs.promises,
        // The async write stalls mid-writeFile; meanwhile the quit path lands.
        writeFile: async (...args) => { await gate; return fs.promises.writeFile(...args); },
      },
    };
    const store = createTabStore(dir, { fsImpl: slowFs, writeDelayMs: 0 });
    store.save({ version: INVENTORY_VERSION, savedAt: 1, scopes: { s: { profileKey: PROJECT, activeTabId: "closed", tabs: [{ id: "closed", url: "https://closed.example/" }] } } });
    const stalled = store.flush();
    // The tab was closed and the app quit: the newest state is written sync.
    store.flushSync({ version: INVENTORY_VERSION, savedAt: 2, scopes: {} });
    expect(store.load().savedAt).toBe(2);
    release();
    await stalled;
    // The stale write finished after the flush — and did not replace it.
    expect(store.load()).toEqual({ version: INVENTORY_VERSION, savedAt: 2, scopes: {} });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(store.lastError).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("flushSync writes the newest document immediately (the quit path) and an unreadable file loads as nothing", () => {
    const dir = tmp();
    const store = createTabStore(dir, { writeDelayMs: 60_000 });
    store.save({ version: INVENTORY_VERSION, savedAt: 1, scopes: {} });
    store.flushSync();
    expect(store.load().savedAt).toBe(1);
    fs.writeFileSync(store.file, "{not json");
    expect(store.load()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
