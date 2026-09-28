/**
 * THE TEARDOWN HELPER MUST STILL BE ABLE TO GO RED (#789).
 *
 * `removeUserData` exists so a transient `ENOTEMPTY` stops reporting itself as
 * a test failure. The obvious way to get that wrong is a retry loop that can
 * never run out: cleanup that always succeeds is the same bug as a test nobody
 * runs. So both directions are measured here — that a directory Chromium lets
 * go of mid-budget IS removed, and that one which never becomes removable
 * exhausts the budget and throws a message naming itself as teardown.
 *
 * THE RETRY PATH IS DRIVEN THROUGH THE INJECTED `rm`, not through a real
 * directory, and deliberately: `rm` is synchronous, so nothing running on this
 * thread could release a real directory part-way through the budget. A fake
 * that fails twice and then succeeds is the only way to assert the recovery
 * the helper exists for actually happens.
 *
 * AND THEN ONCE AGAINST THE REAL FILESYSTEM, because an injected port proves
 * the loop and not the call it wraps. A parent with no write bit cannot have
 * its child unlinked, so the real `fs.rmSync` genuinely fails — note that the
 * errno differs by runtime (Node says `ENOTEMPTY`, Bun says `EACCES`), which is
 * why the helper owns its budget and why this asserts the shape of the message
 * rather than one runtime's code.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, expect, test } = require("bun:test");

const { removeUserData } = require("./electron-test-teardown");

// Root ignores the write bit, so a read-only parent forces nothing there and
// the real-filesystem case below would fail for the environment rather than
// for the code. CI is ubuntu-latest and macos-latest, both unprivileged, so it
// runs where it means something — and the give-up path it exercises is already
// covered unconditionally by the injected-`rm` case, so nothing load-bearing
// rides on it.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const made = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-teardown-test-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  // Put the write bit back first, or this file leaks the very directories it
  // made unremovable.
  while (made.length) {
    const dir = made.pop();
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) fs.chmodSync(path.join(dir, entry.name), 0o700);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function enotempty() {
  const error = new Error("ENOTEMPTY, Directory not empty");
  error.code = "ENOTEMPTY";
  error.syscall = "rm";
  return error;
}

describe("removeUserData", () => {
  test("removes a temp profile the way every electron test's finally needs it to", async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "Partitions", "telar"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Partitions", "telar", "Cookies"), "not really a jar");

    const { attempts } = await removeUserData(dir);

    expect(fs.existsSync(dir)).toBe(false);
    expect(attempts).toBe(1);
  });

  test("is quiet about a directory that is already gone", async () => {
    const dir = scratch();
    fs.rmSync(dir, { recursive: true, force: true });

    await removeUserData(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  test("waits out a Chromium that is still writing, and reports how many tries it took", async () => {
    const slept = [];
    let calls = 0;
    const rm = () => {
      calls += 1;
      if (calls < 3) throw enotempty();
    };

    const result = await removeUserData("/not/touched", {
      attempts: 20,
      delayMs: 100,
      rm,
      wait: async (ms) => void slept.push(ms),
    });

    expect(result.attempts).toBe(3);
    // Twice, not three times: the attempt that succeeds must not pay a delay.
    expect(slept).toEqual([100, 100]);
  });

  test("still goes red, named, when nothing ever releases the directory", async () => {
    const slept = [];
    let calls = 0;

    let thrown = null;
    try {
      await removeUserData("/not/touched", {
        attempts: 4,
        delayMs: 100,
        rm: () => {
          calls += 1;
          throw enotempty();
        },
        wait: async (ms) => void slept.push(ms),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(calls).toBe(4);
    // Three delays for four attempts — the budget is spent between tries, not
    // after the last one.
    expect(slept).toEqual([100, 100, 100]);
    // The three things the message has to carry: that this is teardown and not
    // the subject, how hard it tried, and the OS's own answer.
    expect(thrown.message).toContain("TEARDOWN:");
    expect(thrown.message).toContain("after 4 attempts");
    expect(thrown.message).toContain("ENOTEMPTY");
    expect(thrown.message).toContain("This is cleanup, not the behaviour under test.");
    expect(thrown.cause.code).toBe("ENOTEMPTY");
  });

  test.skipIf(IS_ROOT)("goes red against the real filesystem too, when the directory truly cannot be emptied", async () => {
    const dir = scratch();
    const locked = path.join(dir, "Partitions");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "Cookies-journal"), "a child is still writing");
    fs.chmodSync(locked, 0o500);

    let thrown = null;
    try {
      await removeUserData(dir, { attempts: 2, delayMs: 1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.message).toContain("TEARDOWN:");
    expect(thrown.message).toContain(dir);
    expect(thrown.cause).toBeTruthy();
    expect(fs.existsSync(dir)).toBe(true);
  });
});
