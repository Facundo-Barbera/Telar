const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { createTabStore, serializeInventory, parseInventory, rememberableUrl, INVENTORY_VERSION } = require("./browser-tab-store");

const PROJECT = "project_0123456789abcdef0123456789abcdef";
const OTHER = "project_fedcba9876543210fedcba9876543210";
const mapping = { legacyOwnerProjectId: null };

function inventory(tabs, { profiles, active } = {}) {
  return serializeInventory({
    tabs,
    profiles: new Map(profiles ?? [["s1", PROJECT]]),
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
      profileKey: PROJECT,
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
      { profiles: [["s1", PROJECT], ["s2", "none"]], active: [["s1", "a"], ["s2", "c"]] },
    );
    const scopes = parseInventory(JSON.parse(JSON.stringify(doc)), mapping);
    expect(scopes).toEqual([
      {
        scopeKey: "s1",
        profileKey: PROJECT,
        activeTabId: "a",
        tabs: [
          { id: "a", url: "https://one.example/", title: "One", openedBy: "human" },
          { id: "b", url: "https://two.example/", title: "Two", openedBy: "agent", viewport: { width: 768, height: 1024 } },
        ],
      },
      { scopeKey: "s2", profileKey: "none", activeTabId: "c", tabs: [{ id: "c", url: "https://three.example/", title: "Three", openedBy: "agent" }] },
    ]);
  });

  test("a hand-edited file cannot smuggle an extension page, a duplicate id, a bad viewport, or an unmappable profile", () => {
    const scopes = parseInventory(
      {
        version: INVENTORY_VERSION,
        scopes: {
          good: {
            profileKey: PROJECT,
            activeTabId: "zzz",
            tabs: [
              { id: "a", url: "chrome-extension://abc/unlock.html", title: "Unlock" },
              { id: "b", url: "https://ok.example/", title: "ok", viewport: { width: 10, height: 10 } },
              { id: "b", url: "https://dup.example/", title: "dup" },
              "garbage",
              { id: "", url: "https://noid.example/" },
            ],
          },
          legacyGrab: { profileKey: "legacy", tabs: [{ id: "x", url: "https://x.example/" }] },
          wrongShape: { profileKey: OTHER, tabs: [{ id: "y", url: "https://y.example/" }] },
          "": { profileKey: OTHER, tabs: [{ id: "z", url: "https://z.example/" }] },
        },
      },
      mapping,
    );
    expect(scopes).toEqual([
      { scopeKey: "good", profileKey: PROJECT, activeTabId: "b", tabs: [{ id: "b", url: "https://ok.example/", title: "ok", openedBy: "agent" }] },
      { scopeKey: "wrongShape", profileKey: OTHER, activeTabId: "y", tabs: [{ id: "y", url: "https://y.example/", title: "New tab", openedBy: "agent" }] },
    ]);
  });

  test("an unknown version, a null document, or a non-object is nothing to restore", () => {
    expect(parseInventory(null, mapping)).toEqual([]);
    expect(parseInventory({ version: 99, scopes: { s: { profileKey: PROJECT, tabs: [{ id: "a", url: "https://a.example/" }] } } }, mapping)).toEqual([]);
    expect(parseInventory("nonsense", mapping)).toEqual([]);
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
