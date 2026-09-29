const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { DEV_SOUNDS, createChime } = require("./notification-sound");
const { createDesktopNotifier, DESKTOP_NOTICE } = require("./desktop-notifications");

class FakeNotification {
  constructor(options) {
    this.options = options;
  }
  on() {
    return this;
  }
  show() {}
  close() {}
}

function show(chime, sound) {
  const made = [];
  const notifier = createDesktopNotifier({
    Notification: class extends FakeNotification { constructor(o) { super(o); made.push(this); } },
    send() {}, context: () => ({}), open() {}, chime,
  });
  notifier.handleServerMessage({
    type: DESKTOP_NOTICE, kind: "finished", sessionId: "s1", title: "Fix the build",
    body: "A session finished. Its result is ready to review.", path: "/main", ...(sound === undefined ? {} : { sound }),
  });
  return made[0].options;
}

describe("a banner's sound", () => {
  test("packaged, the banner names the bundled file and macOS plays it", () => {
    const played = [];
    const options = show(createChime({ bundled: true, play: (file) => played.push(file) }), "telar-hilo-done");
    expect(options.sound).toBe("telar-hilo-done.wav");
    expect(options.silent).toBeUndefined();
    expect(played).toEqual([]);
  });

  test("in dev, the banner is silent and the shell plays the cockpit's copy", () => {
    const played = [];
    const options = show(createChime({ bundled: false, play: (file) => played.push(file) }), "telar-felt-needs");
    expect(options.silent).toBe(true);
    expect(played).toEqual([path.join(DEV_SOUNDS, "telar-felt-needs.wav")]);
    expect(fs.existsSync(played[0])).toBe(true);
  });

  test("no sound, or one it doesn't know, is silence rather than the system default", () => {
    for (const bundled of [true, false]) {
      const played = [];
      const chime = createChime({ bundled, play: (file) => played.push(file) });
      for (const sound of [undefined, "Basso", "../../etc/passwd"]) {
        const options = show(chime, sound);
        expect(options.silent).toBe(true);
        expect(options.sound).toBeUndefined();
      }
      expect(played).toEqual([]);
    }
  });

});
