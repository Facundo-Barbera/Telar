const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { DEV_SOUNDS, createChime } = require("./notification-sound");
const { createDesktopNotifier, DESKTOP_NOTICE } = require("./desktop-notifications");

class FakeNotification {
  constructor(options) {
    this.options = options;
    this.handlers = {};
  }
  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
  show() {
    if (FakeNotification.allowed) this.handlers.show?.();
  }
  close() {}
}

function show(packaged, sound, allowed = true) {
  FakeNotification.allowed = allowed;
  const made = [];
  const played = [];
  const notifier = createDesktopNotifier({
    Notification: class extends FakeNotification { constructor(o) { super(o); made.push(this); } },
    send() {}, context: () => ({}), open() {}, chime: createChime({ packaged, play: (file) => played.push(file) }),
  });
  notifier.handleServerMessage({
    type: DESKTOP_NOTICE, kind: "finished", sessionId: "s1", title: "Fix the build",
    body: "A session finished. Its result is ready to review.", path: "/main", ...(sound === undefined ? {} : { sound }),
  });
  return { notifier, made, options: made[0].options, played };
}

const IOS_SOUNDS = path.join(__dirname, "..", "..", "..", "ios", "TelarMobile", "Sounds");

describe("a banner's sound", () => {
  test("packaged, macOS plays the bundled .caf itself and the shell plays nothing", () => {
    const { options, played } = show(true, "telar-hilo-done");
    expect(options.silent).toBeUndefined();
    expect(options.sound).toBe("telar-hilo-done.caf");
    expect(played).toEqual([]);
  });

  test("every sound the engine can name ships as a .caf the packaged app bundles", () => {
    for (const set of ["hilo", "armonico", "felt"]) {
      for (const kind of ["done", "needs", "error"]) expect(fs.existsSync(path.join(IOS_SOUNDS, `telar-${set}-${kind}.caf`))).toBe(true);
    }
  });

  test("in dev, the banner is silent and the shell plays the cockpit's copy", () => {
    const { options, played } = show(false, "telar-felt-needs");
    expect(options).toMatchObject({ silent: true });
    expect(options.sound).toBeUndefined();
    expect(played).toEqual([path.join(DEV_SOUNDS, "telar-felt-needs.wav")]);
    expect(fs.existsSync(played[0])).toBe(true);
  });

  test("a banner macOS refuses to show makes no sound in dev", () => {
    expect(show(false, "telar-hilo-done", false).played).toEqual([]);
  });

  test("Off, or a sound it doesn't know, is silence rather than the system default", () => {
    for (const packaged of [true, false]) {
      for (const sound of [undefined, "Basso", "../../etc/passwd"]) {
        const { options, played } = show(packaged, sound);
        expect(options.silent).toBe(true);
        expect(options.sound).toBeUndefined();
        expect(played).toEqual([]);
      }
    }
  });
});

describe("a test notification", () => {
  test("shows a real banner with the chosen set's sound", () => {
    const { notifier, made } = show(true, undefined);
    expect(notifier.test("armonico")).toEqual({ ok: true });
    expect(made[1].options).toMatchObject({ title: "Telar", sound: "telar-armonico-done.caf" });
  });

  test("refuses Off or a name it doesn't know", () => {
    const { notifier, made } = show(true, undefined);
    for (const sounds of ["off", "../x", undefined]) expect(notifier.test(sounds)).toEqual({ ok: false });
    expect(made).toHaveLength(1);
  });
});
