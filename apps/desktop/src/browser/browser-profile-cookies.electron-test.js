const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DesktopBrowserManager } = require("./browser-manager");
const { createTabStore } = require("./browser-tab-store");
const { readProfileRegistry } = require("./browser-profiles");
const { removeUserData } = require("../../test/electron/electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profile-cookies-"));
app.setPath("userData", userData);

const PROJECT_A = "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT_B = "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT_C = "project_cccccccccccccccccccccccccccccccc";
const MIGRATED = "project_dddddddddddddddddddddddddddddddd";

function assert(condition, message) { if (!condition) throw new Error(message); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }

async function settle(tab) {
  for (let i = 0; i < 60; i += 1) {
    if (!tab.loading && (await tab.view.webContents.executeJavaScript("document.readyState")) === "complete") return;
    await delay(100);
  }
  throw new Error("page did not settle");
}

async function seenCookie(manager, scope) {
  const tab = manager.activeTab(scope);
  await manager.wakeTab(tab);
  await settle(tab);
  return tab.view.webContents.executeJavaScript("document.getElementById('who').textContent");
}

async function signIn(manager, base, scope, as) {
  await manager.action(scope, { action: "new", url: `${base}/signin?as=${as}` });
  await settle(manager.activeTab(scope));
  await manager.action(scope, { action: "navigate", url: `${base}/` });
  await settle(manager.activeTab(scope));
}

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const headers = { "Content-Type": "text/html; charset=utf-8" };

    const as = url.searchParams.get("as");
    if (url.pathname === "/signin" && as) headers["Set-Cookie"] = `who=${as}; Path=/; Max-Age=86400`;
    response.writeHead(200, headers);
    const who = /(?:^|;\s*)who=([^;]*)/.exec(request.headers.cookie || "")?.[1] ?? "nobody";
    response.end(`<!doctype html><title>profile fixture</title><body><div id="who">${who}</div></body>`);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const note = (line) => console.log(`PROFILE_COOKIES ${line}`);

  const window = new BrowserWindow({ show: false, width: 900, height: 600 });
  window.showInactive();
  let manager = new DesktopBrowserManager(window, {
    profiles: readProfileRegistry(userData),
    tabStore: createTabStore(userData, { writeDelayMs: 10 }),
  });
  try {
    const legacyPartition = `persist:telar-project-${MIGRATED.slice("project_".length)}`;
    manager.profiles.document.profiles.bp_00000000000000ff = {
      id: "bp_00000000000000ff",
      label: "Pre-profile",
      partition: legacyPartition,
      createdAt: 0,
    };
    manager.profiles.document.projects[MIGRATED] = "bp_00000000000000ff";
    manager.declareProfile("legacy", MIGRATED);
    await signIn(manager, base, "legacy", "legacy-identity");
    assert((await seenCookie(manager, "legacy")) === "legacy-identity", "the pre-profile jar did not take the cookie");

    delete manager.profiles.document.projects[MIGRATED];
    delete manager.profiles.document.profiles.bp_00000000000000ff;
    manager.profiles.save();

    const work = manager.profiles.create({ label: "Work", account: "me@work.example" });
    manager.profiles.assign(PROJECT_A, work.id);
    manager.profiles.assign(PROJECT_B, work.id);
    manager.declareProfile("a", PROJECT_A);
    manager.declareProfile("b", PROJECT_B);
    assert(manager.partitionOf("a") === manager.partitionOf("b"), "two projects on one profile did not share a partition");

    await signIn(manager, base, "a", "work-account");
    await manager.action("b", { action: "new", url: `${base}/` });
    const sharedSeen = await seenCookie(manager, "b");
    note(`project B, same profile as A: ${sharedSeen}`);
    assert(sharedSeen === "work-account", `a shared profile did not share the login: ${sharedSeen}`);

    const personal = manager.profiles.create({ label: "Personal" });
    manager.profiles.assign(PROJECT_C, personal.id);
    manager.declareProfile("c", PROJECT_C);
    await manager.action("c", { action: "new", url: `${base}/` });
    const isolated = await seenCookie(manager, "c");
    note(`project C, different profile: ${isolated}`);
    assert(isolated === "nobody", `a distinct profile saw another profile's cookie: ${isolated}`);

    const openTab = manager.activeTab("b");
    const openContents = openTab.view.webContents;
    manager.setScopeProfile("b", personal.id);
    assert(openTab.view.webContents === openContents, "switching profiles rebuilt a live tab");
    assert(openTab.partition !== manager.partitionOf("b"), "the open tab followed the session into the new profile");
    await openTab.view.webContents.reload();
    await settle(openTab);
    const stillWork = await openTab.view.webContents.executeJavaScript("document.getElementById('who').textContent");
    note(`the tab open before the switch still reports: ${stillWork}`);
    assert(stillWork === "work-account", `an open tab lost its identity on a profile switch: ${stillWork}`);

    await manager.action("b", { action: "new", url: `${base}/` });
    const fresh = await seenCookie(manager, "b");
    note(`the next tab after the switch reports: ${fresh}`);
    assert(fresh === "nobody", `the new tab did not open in the new profile: ${fresh}`);

    //    global default now exists that a naive migration would have used. ──
    manager.profiles.setDefault(work.id);
    manager.releaseScope("legacy", true);
    manager.declareProfile("legacy2", MIGRATED);
    assert(manager.partitionOf("legacy2") === legacyPartition, `migration did not adopt the existing jar: ${manager.partitionOf("legacy2")}`);
    await manager.action("legacy2", { action: "new", url: `${base}/` });
    const migrated = await seenCookie(manager, "legacy2");
    note(`migrated project after a default was set: ${migrated}`);
    assert(migrated === "legacy-identity", `migration lost the project's identity: ${migrated}`);

    manager.destroy();
    manager = new DesktopBrowserManager(window, {
      profiles: readProfileRegistry(userData),
      tabStore: createTabStore(userData, { writeDelayMs: 10 }),
    });
    manager.declareProfile("a2", PROJECT_A);
    assert(manager.partitionOf("a2") === work.partition, "the project assignment did not survive a restart");
    assert(manager.profiles.get(work.id).account === "me@work.example", "the expected account did not survive a restart");
    assert(manager.profiles.defaultProfileId === work.id, "the default profile did not survive a restart");
    await manager.action("a2", { action: "new", url: `${base}/` });
    const afterRestart = await seenCookie(manager, "a2");
    note(`after restart, project A: ${afterRestart}`);
    assert(afterRestart === "work-account", `the shared profile's login did not survive a restart: ${afterRestart}`);

    console.log("PROFILE_COOKIES_OK");
  } finally {
    try { manager.destroy(); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await removeUserData(userData);
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("PROFILE_COOKIES_FAIL", error);
    app.exit(1);
  },
);
