const { describe, expect, test } = require("bun:test");

const { DesktopBrowserManager, managerForScope } = require("./browser-manager");
const { FakeView, makeHarness } = require("../../test/browser-manager-harness");
describe("per-project browser profiles", () => {
  test("an UNBOUND scope refuses to open a tab — missing project metadata fails closed", async () => {
    const { manager } = makeHarness();

    manager.createTab = DesktopBrowserManager.prototype.createTab.bind(manager);
    await expect(manager.createTab("unbound", "https://example.com")).rejects.toThrow(/not bound to a project profile/);
  });
  test("two sessions of one project share a partition; a project assigned elsewhere does not", () => {
    const { manager } = makeHarness();
    manager.declareProfile("a1", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("a2", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b1", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("a1")).toBe(manager.partitionOf("a2"));

    expect(manager.partitionOf("b1")).toBe(manager.partitionOf("a1"));
    const own = manager.profiles.create({ label: "B's own" });
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", own.id);
    manager.declareProfile("b2", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("b2")).not.toBe(manager.partitionOf("a1"));
    expect(manager.state("a1").profileKey).toBe("project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
  test("the legacy partition is used only by its declared owner", () => {
    const { manager } = makeHarness();
    manager.profiles.document.legacyOwnerProjectId = "project_cccccccccccccccccccccccccccccccc";

    manager.profiles.partitionExists = (partition) => partition === "persist:telar-integrated-browser";
    manager.declareProfile("owner", "project_cccccccccccccccccccccccccccccccc");
    manager.declareProfile("other", "project_dddddddddddddddddddddddddddddddd");
    expect(manager.partitionOf("owner")).toBe("persist:telar-integrated-browser");
    expect(manager.partitionOf("other")).not.toBe("persist:telar-integrated-browser");
  });
  test("a tab keeps its partition; the extension host is resolved per partition", async () => {
    const { manager } = makeHarness();
    const hostsByPartition = new Map();
    manager.createExtensionHost = (partition) => {
      const host = { partition, added: [], addTab(wc) { this.added.push(wc); }, removeTab() {}, selectTab() {}, whenReady: async () => ({}) };
      hostsByPartition.set(partition, host);
      return host;
    };

    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", manager.profiles.create({ label: "B" }).id);
    manager.declareProfile("a", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await manager.createTab("a", "https://one.example");
    await manager.createTab("b", "https://two.example");
    const pa = manager.partitionOf("a");
    const pb = manager.partitionOf("b");
    expect(pa).not.toBe(pb);
    expect(hostsByPartition.get(pa).added).toHaveLength(1);
    expect(hostsByPartition.get(pb).added).toHaveLength(1);

    expect(hostsByPartition.get(pa).added[0]).not.toBe(hostsByPartition.get(pb).added[0]);
  });
  test("switching a session's profile leaves its open tabs in the identity they were signed into", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await manager.createTab("s", "https://one.example");
    const before = manager.scopeTabs("s")[0];
    const beforePartition = before.partition;
    const view = before.view;

    const other = manager.profiles.create({ label: "Other" });
    const binding = manager.setScopeProfile("s", other.id);
    expect(binding.profileId).toBe(other.id);

    expect(before.view).toBe(view);
    expect(before.partition).toBe(beforePartition);
    expect(before.profileId).not.toBe(other.id);

    await manager.createTab("s", "https://two.example");
    const [old, fresh] = manager.scopeTabs("s");
    expect(old.partition).toBe(beforePartition);
    expect(fresh.partition).toBe(other.partition);

    const state = manager.state("s");
    expect(state.profile.id).toBe(other.id);
    expect(state.tabs.map((tab) => tab.profileId)).toEqual([old.profileId, other.id]);
  });

  test("a session's own profile choice survives the engine re-declaring the same project every turn", () => {
    const { manager } = makeHarness();
    const project = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    manager.declareProfile("s", project);
    const chosen = manager.profiles.create({ label: "Chosen" });
    manager.setScopeProfile("s", chosen.id);
    expect(manager.declareProfile("s", project).profileId).toBe(chosen.id);
    expect(manager.partitionOf("s")).toBe(chosen.partition);
  });

  test("a project assigned to a profile puts every one of its sessions in that identity", () => {
    const { manager } = makeHarness();
    const shared = manager.profiles.create({ label: "Shared" });
    manager.profiles.assign("project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shared.id);
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shared.id);
    manager.declareProfile("a", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("b", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(manager.partitionOf("a")).toBe(shared.partition);
    expect(manager.partitionOf("b")).toBe(shared.partition);

    const personal = manager.profiles.create({ label: "Personal" });
    manager.profiles.setDefault(personal.id);
    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null);
    expect(manager.declareProfile("b2", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").partition).toBe(personal.partition);

    expect(manager.declareProfile("a2", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").partition).toBe(shared.partition);
  });

  test("a scope that would switch PROJECT with tabs open is refused, and a dangling profile id is never guessed", async () => {
    const { manager } = makeHarness();
    manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await manager.createTab("s", "https://one.example");
    expect(() => manager.declareProfile("s", "none")).toThrow(/already has tabs in profile/);
    expect(() => manager.setScopeProfile("s", "bp_00000000000000ff")).toThrow(/No browser profile/);
  });

  describe("deleteProfile — forgetting a profile moves what was browsing in it", () => {
    test("a session with tabs in the profile moves to the default, and its tabs sleep there with their URLs", async () => {
      const { manager } = makeHarness();
      const fallback = manager.profiles.get(manager.profiles.defaultProfileId);
      const work = manager.profiles.create({ label: "Work" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", work.id);
      await manager.createTab("s", "https://one.example");
      await manager.createTab("s", "https://two.example");

      const removed = manager.deleteProfile(work.id);

      expect(removed).toMatchObject({ id: work.id, label: "Work", sessions: 1, tabs: 2 });
      expect(manager.profiles.get(work.id)).toBeNull();
      expect(manager.scopeProfiles.get("s")).toBe(fallback.id);
      expect(manager.scopeProfileOverrides.has("s")).toBe(false);
      const tabs = manager.scopeTabs("s");
      expect(tabs.map((tab) => tab.view)).toEqual([null, null]);
      expect(tabs.every((tab) => tab.profileId === fallback.id && tab.partition === fallback.partition)).toBe(true);
      expect(tabs.map((tab) => tab.url)).toEqual(["https://one.example/", "https://two.example/"]);
    });

    test("a tab left in the profile after its session switched away is re-homed in the session's current profile", async () => {
      const { manager } = makeHarness();
      const old = manager.profiles.create({ label: "Old" });
      const next = manager.profiles.create({ label: "Next" });
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      manager.setScopeProfile("s", old.id);
      await manager.createTab("s", "https://one.example");
      manager.setScopeProfile("s", next.id);

      expect(manager.deleteProfile(old.id)).toMatchObject({ sessions: 1, tabs: 1 });
      expect(manager.scopeProfiles.get("s")).toBe(next.id);
      expect(manager.scopeTabs("s")[0]).toMatchObject({ profileId: next.id, partition: next.partition, view: null });
    });

    test("a remembered session's hibernated tabs move too, and the saved inventory names a profile that exists", () => {
      let saved;
      const { manager } = makeHarness({
        tabStore: {
          load: () => ({
            version: 1,
            savedAt: 1,
            scopes: {
              s1: {
                profileKey: "project_0123456789abcdef0123456789abcdef",
                activeTabId: "a",
                tabs: [{ id: "a", url: "https://one.example/", title: "One", openedBy: "human" }],
              },
            },
          }),
          save: (inventory) => { saved = inventory; },
          flushSync: () => {},
        },
      });
      const spare = manager.profiles.create({ label: "Spare" });
      manager.profiles.setDefault(spare.id);
      const restored = manager.scopeTabs("s1")[0].profileId;

      expect(manager.deleteProfile(restored)).toMatchObject({ sessions: 1, tabs: 1 });
      expect(manager.scopeTabs("s1")[0].profileId).toBe(spare.id);
      expect(manager.scopeProfiles.get("s1")).toBe(spare.id);
      return Promise.resolve().then(() => {
        expect(JSON.stringify(saved)).not.toContain(restored);
      });
    });

    test("the default is still refused, and nothing moves", async () => {
      const { manager } = makeHarness();
      const fallback = manager.profiles.get(manager.profiles.defaultProfileId);
      manager.declareProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      await manager.createTab("s", "https://one.example");
      expect(() => manager.deleteProfile(fallback.id)).toThrow("Make another profile the default first.");
      expect(manager.scopeTabs("s")[0].view).not.toBeNull();
    });
  });

  test("adopt refuses tabs from a different profile", async () => {
    const { manager } = makeHarness();

    manager.profiles.assign("project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", manager.profiles.create({ label: "To" }).id);
    manager.declareProfile("from", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    manager.declareProfile("to", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await manager.createTab("from", "https://one.example");
    expect(() => manager.adoptScope("from", "to")).toThrow(/across browser profiles/);
  });
});

describe("the login offer capture", () => {
  test("an entry captures the tab's address and identity; focus captures nothing", async () => {
    const clock = { t: 50_000 };
    const { manager, views } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://accounts.example.com/signin?next=/inbox");
    const wc = views[0].webContents;

    manager.noteLoginEntryFromWebContents(wc, { kind: "focus" });
    expect(manager.heldLoginCapture).toBeNull();

    manager.noteLoginEntryFromWebContents(wc, { kind: "fill" });
    expect(manager.heldLoginCapture).toMatchObject({
      origin: "https://accounts.example.com",
      tabUid: manager.scopeTabs("s")[0].id,
      at: 50_000,
    });
    expect(manager.heldLoginCapture.profileId).toBeTruthy();
  });

  test("the capture is taken AT ENTRY and a later navigation does not move it", async () => {
    const finished = [];
    const { manager, views } = makeHarness({ onLoginEntryFinished: (capture) => finished.push(capture) });
    await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });

    await views[0].webContents.loadURL("https://mail.example.com/u/0");
    expect(finished.at(-1)?.origin ?? manager.heldLoginCapture.origin).toBe("https://accounts.example.com");
  });

  test("leaving the page hands the capture on, once", async () => {
    const finished = [];
    const { manager, views } = makeHarness({ onLoginEntryFinished: (capture) => finished.push(capture) });
    const tab = await manager.createTab("s", "https://accounts.example.com/signin");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });

    expect(finished.length).toBe(0);
    manager.noteNavigation(tab);
    expect(finished.length).toBe(1);
    expect(finished[0].origin).toBe("https://accounts.example.com");
    expect(manager.heldLoginCapture).toBeNull();

    manager.noteNavigation(tab);
    expect(finished.length).toBe(1);
  });

  test("a page that cannot carry a grant is never captured", async () => {
    const { manager, views } = makeHarness();
    await manager.createTab("s", "about:blank");
    manager.noteLoginEntryFromWebContents(views[0].webContents, { kind: "input" });
    expect(manager.heldLoginCapture).toBeNull();
  });

  test("loginCaptureForScope — the explicit offer's capture — reads the active tab now", async () => {
    const clock = { t: 90_000 };
    const { manager } = makeHarness({ now: () => clock.t });
    await manager.createTab("s", "https://mail.example.com/u/0", "human");
    const capture = manager.loginCaptureForScope("s");
    expect(capture).toMatchObject({ origin: "https://mail.example.com", at: 90_000 });

    const { manager: blank } = makeHarness();
    await blank.createTab("s2", "about:blank", "human");
    expect(blank.loginCaptureForScope("s2")).toBeNull();
  });
});

describe("the agent's scope finds its own window's browser", () => {
  const windows = () => {
    const one = makeHarness().manager;
    const two = makeHarness().manager;
    return { one, two, set: new Set([one, two]) };
  };
  const PANEL = { x: 0, y: 0, width: 800, height: 600 };

  test("no window claims the scope: the window the human is in answers, as it always did", async () => {
    const { one, two, set } = windows();

    await one.createTab("session-b", "https://b.example/");
    expect(managerForScope(set, "session-a", two)).toBe(two);
    expect(managerForScope(set, "session-a", one)).toBe(one);
  });

  test("the session's panel is in the second window: that window answers, whichever one is focused", async () => {
    const { one, two, set } = windows();
    two.setBounds("session-a", PANEL);
    await two.setVisible("session-a", true);
    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("live pages are a claim of their own, for a session no panel is mounted for", async () => {
    const { one, two, set } = windows();
    await two.createTab("session-a", "https://a.example/");
    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("a panel showing the session outranks another window's live pages of it", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    two.setBounds("session-a", PANEL);
    await two.setVisible("session-a", true);

    expect(managerForScope(set, "session-a", one)).toBe(two);
  });

  test("a second Browser panel tab is the same session: `S` finds the window holding `S#2`", async () => {
    const { one, two, set } = windows();
    two.setBounds("session-a#browser-2", PANEL);
    await two.setVisible("session-a#browser-2", true);
    expect(managerForScope(set, "session-a", one)).toBe(two);

    expect(two.state("session-a").tabs).toEqual([]);
  });

  test("but an instance-qualified scope never borrows the window of its session", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    expect(managerForScope(set, "session-a#browser-2", two)).toBe(two);
  });

  test("an exact scope outranks a sibling instance with a stronger claim", async () => {
    const { one, two, set } = windows();
    await one.createTab("session-a", "https://a.example/");
    two.setBounds("session-a#browser-2", PANEL);
    await two.setVisible("session-a#browser-2", true);
    expect(managerForScope(set, "session-a", two)).toBe(one);
  });

  test("two windows with an equal claim: the window the human is in breaks the tie", () => {
    const { one, two, set } = windows();
    one.setBounds("session-a", PANEL);
    two.setBounds("session-a", PANEL);
    expect(managerForScope(set, "session-a", one)).toBe(one);
    expect(managerForScope(set, "session-a", two)).toBe(two);
  });

  test("a remembered tab is not a claim — every window's host restores the same inventory", async () => {
    const { manager: source } = makeHarness();
    const saved = [];
    source.tabStore = { load: () => null, save: (doc) => saved.push(doc), flushSync: () => {} };
    await source.createTab("session-a", "https://a.example/");
    await Promise.resolve();
    const doc = saved.at(-1);

    const reopen = () => {
      const window = { isDestroyed: () => false, webContents: { send: () => {} }, contentView: { addChildView: () => {}, removeChildView: () => {} } };
      const manager = new DesktopBrowserManager(window, {
        createId: () => "x",
        createView: () => new FakeView(),
        wait: async () => {},
        profiles: source.profiles,
        tabStore: { load: () => doc, save: () => {}, flushSync: () => {} },
      });
      manager.ensureAutoRelease = () => {};
      return manager;
    };
    const one = reopen();
    const two = reopen();

    expect(one.state("session-a").tabs).toHaveLength(1);
    expect(two.state("session-a").tabs).toHaveLength(1);
    expect(one.scopeClaim("session-a")).toBe(0);
    expect(managerForScope(new Set([one, two]), "session-a", two)).toBe(two);
  });

  test("a closed window's host claims nothing, and an empty scope claims nowhere", async () => {
    const { one, two, set } = windows();
    await two.createTab("session-a", "https://a.example/");
    two.destroy();
    expect(two.scopeClaim("session-a")).toBe(0);
    expect(managerForScope(set, "session-a", one)).toBe(one);
    expect(one.scopeClaim("")).toBe(0);
    expect(one.scopeClaim(null)).toBe(0);
  });
});
