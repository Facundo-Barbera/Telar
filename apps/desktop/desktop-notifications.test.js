// THE MAC'S OWN NOTIFICATIONS — the shell half, driven with a fake
// Notification class. Nothing here touches Electron, a store or the network.
const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  DESKTOP_NOTIFICATIONS_ENV, DESKTOP_NOTICE, DESKTOP_APPROVE, DESKTOP_APPROVED,
  parseNotice, routeOf, shouldNotifyDesktop, createDesktopNotifier,
} = require("./desktop-notifications");

class FakeNotification {
  static made = [];
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.shown = false;
    this.closed = false;
    FakeNotification.made.push(this);
  }
  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
    this.handlers.close?.({});
  }
}

function harness(context = {}) {
  FakeNotification.made = [];
  const sent = [];
  const opened = [];
  const notifier = createDesktopNotifier({
    Notification: FakeNotification,
    send: (message) => sent.push(message),
    context: () => context,
    open: (route) => opened.push(route),
  });
  return { notifier, sent, opened };
}

const notice = (patch = {}) => ({
  type: DESKTOP_NOTICE, kind: "blocked", sessionId: "s1", title: "Fix the build",
  body: "A session needs your input or approval.", path: "/projects/p1/sessions/s1", ...patch,
});

describe("the channel's contract", () => {
  test("both halves spell the env var and message types the same", () => {
    const server = fs.readFileSync(path.join(__dirname, "../web/lib/mobile/desktop.ts"), "utf8");
    for (const [name, value] of Object.entries({ DESKTOP_NOTIFICATIONS_ENV, DESKTOP_NOTICE, DESKTOP_APPROVE, DESKTOP_APPROVED })) {
      expect(server).toContain(`export const ${name} = "${value}";`);
    }
  });

  test("main.js forks the server with the flag and listens on that child only", () => {
    const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
    expect(main).toContain("[DESKTOP_NOTIFICATIONS_ENV]: \"1\"");
    expect(main).toContain("serverChild.on(\"message\", (message) => desktopNotifier.handleServerMessage(message));");
  });

  test("a notice must be well formed, and its path must stay inside the app", () => {
    expect(parseNotice(notice())).toMatchObject({ sessionId: "s1", path: "/projects/p1/sessions/s1" });
    for (const bad of [
      null, "notice", { ...notice(), type: "other" }, notice({ kind: "exploded" }), notice({ sessionId: "" }),
      notice({ title: "x".repeat(161) }), notice({ path: "https://evil.example" }), notice({ path: "//evil.example" }),
      notice({ path: "/\\evil.example" }), notice({ request: 7 }),
    ]) expect(parseNotice(bad)).toBeNull();
  });
});

describe("shouldNotifyDesktop", () => {
  test("skips the session on screen in the focused window, and only that", () => {
    const n = { path: "/projects/p1/sessions/s1" };
    expect(shouldNotifyDesktop(n, { focused: true, viewingPath: "/projects/p1/sessions/s1" })).toBe(false);
    expect(shouldNotifyDesktop(n, { focused: false, viewingPath: "/projects/p1/sessions/s1" })).toBe(true);
    expect(shouldNotifyDesktop(n, { focused: true, viewingPath: "/projects/p1/sessions/s2" })).toBe(true);
    expect(shouldNotifyDesktop(n)).toBe(true);
  });

  test("the viewing path is the window's route", () => {
    expect(routeOf("http://127.0.0.1:3000/projects/p1/sessions/s1?panel=diff")).toBe("/projects/p1/sessions/s1");
    expect(routeOf("not a url")).toBeNull();
  });
});

describe("the banner and its actions", () => {
  test("a plain notice shows title and body with Open only; a click opens its session", () => {
    const { notifier, opened, sent } = harness();
    notifier.handleServerMessage(notice());
    const [banner] = FakeNotification.made;
    expect(banner.shown).toBe(true);
    expect(banner.options).toEqual({ title: "Fix the build", body: "A session needs your input or approval.", actions: [{ type: "button", text: "Open" }] });
    banner.handlers.click();
    expect(opened).toEqual(["/projects/p1/sessions/s1"]);
    expect(sent).toEqual([]);
  });

  test("nothing is shown for the session already on screen", () => {
    const { notifier } = harness({ focused: true, viewingPath: "/projects/p1/sessions/s1" });
    notifier.handleServerMessage(notice());
    expect(FakeNotification.made).toHaveLength(0);
  });

  test("Approve sends exactly the request this banner carried, with its session", () => {
    const { notifier, sent, opened } = harness();
    notifier.handleServerMessage(notice({ request: "r1" }));
    const [banner] = FakeNotification.made;
    expect(banner.options.actions.map((a) => a.text)).toEqual(["Approve", "Open"]);
    banner.handlers.action({ actionIndex: 0 });
    expect(sent).toEqual([{ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }]);
    expect(opened).toEqual([]);
    // Landed: nothing more to do.
    notifier.handleServerMessage({ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: true });
    expect(opened).toEqual([]);
  });

  test("an Approve that does not land opens the session instead", () => {
    const { notifier, opened } = harness();
    notifier.handleServerMessage(notice({ request: "r1" }));
    FakeNotification.made[0].handlers.action({ actionIndex: 0 });
    notifier.handleServerMessage({ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: false });
    expect(opened).toEqual(["/projects/p1/sessions/s1"]);
    // A reply for a request this shell never sent opens nothing.
    notifier.handleServerMessage({ type: DESKTOP_APPROVED, sessionId: "s9", requestId: "r9", ok: false });
    expect(opened).toHaveLength(1);
  });

  test("Open, and the legacy index argument, both open without approving", () => {
    const { notifier, sent, opened } = harness();
    notifier.handleServerMessage(notice({ request: "r1" }));
    FakeNotification.made[0].handlers.action({ actionIndex: 1 });
    notifier.handleServerMessage(notice({ sessionId: "s2", path: "/main" }));
    FakeNotification.made[1].handlers.action(undefined, 0);
    expect(sent).toEqual([]);
    expect(opened).toEqual(["/projects/p1/sessions/s1", "/main"]);
  });

  test("a newer notice for the same session replaces the old banner, so a stale Approve is gone", () => {
    const { notifier } = harness();
    notifier.handleServerMessage(notice({ request: "r1" }));
    notifier.handleServerMessage(notice({ kind: "finished", body: "A session finished. Its result is ready to review." }));
    expect(FakeNotification.made[0].closed).toBe(true);
    expect(notifier.liveCount()).toBe(1);
  });
});
