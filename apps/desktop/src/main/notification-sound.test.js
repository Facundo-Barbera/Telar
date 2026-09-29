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

function show(dir, sound, allowed = true) {
  FakeNotification.allowed = allowed;
  const made = [];
  const played = [];
  const notifier = createDesktopNotifier({
    Notification: class extends FakeNotification { constructor(o) { super(o); made.push(this); } },
    send() {}, context: () => ({}), open() {}, chime: createChime({ dir, play: (file) => played.push(file) }),
  });
  notifier.handleServerMessage({
    type: DESKTOP_NOTICE, kind: "finished", sessionId: "s1", title: "Fix the build",
    body: "A session finished. Its result is ready to review.", path: "/main", ...(sound === undefined ? {} : { sound }),
  });
  return { options: made[0].options, played };
}

describe("a banner's sound", () => {
  test("packaged, the banner is silent and the shell plays the bundled file by its absolute path", () => {
    const { options, played } = show("/Applications/Telar.app/Contents/Resources", "telar-hilo-done");
    expect(options.silent).toBe(true);
    expect(options.sound).toBeUndefined();
    expect(played).toEqual(["/Applications/Telar.app/Contents/Resources/telar-hilo-done.wav"]);
  });

  test("in dev, the shell plays the cockpit's copy", () => {
    const { options, played } = show(DEV_SOUNDS, "telar-felt-needs");
    expect(options.silent).toBe(true);
    expect(played).toEqual([path.join(DEV_SOUNDS, "telar-felt-needs.wav")]);
    expect(fs.existsSync(played[0])).toBe(true);
  });

  test("a banner macOS refuses to show makes no sound", () => {
    expect(show(DEV_SOUNDS, "telar-hilo-done", false).played).toEqual([]);
  });

  test("Off, or a sound it doesn't know, is silence rather than the system default", () => {
    for (const sound of [undefined, "Basso", "../../etc/passwd"]) {
      const { options, played } = show(DEV_SOUNDS, sound);
      expect(options.silent).toBe(true);
      expect(options.sound).toBeUndefined();
      expect(played).toEqual([]);
    }
  });
});
