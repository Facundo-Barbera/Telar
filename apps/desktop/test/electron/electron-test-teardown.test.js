const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, expect, test } = require("bun:test");

const { removeUserData } = require("./electron-test-teardown");

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const made = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-teardown-test-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
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

    expect(slept).toEqual([100, 100, 100]);

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
