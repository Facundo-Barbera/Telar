const { afterAll, beforeAll, describe, expect, test } = require("bun:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readKittyImageFile, isForbiddenLocation } = require("./kitty-image-file");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
let dir;
const at = (name) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitty-file-"));
  fs.writeFileSync(at("logo.png"), PNG);
  fs.writeFileSync(at("notes.txt"), "not an image, just text");
  fs.writeFileSync(at("big.png"), Buffer.concat([PNG, Buffer.alloc(100)]));
  fs.mkdirSync(at("folder"));
  fs.symlinkSync(at("logo.png"), at("link-to-logo.png"));
  fs.symlinkSync("/dev/null", at("link-to-dev-null"));
  fs.symlinkSync(at("folder"), at("link-to-folder"));
  execFileSync("mkfifo", [at("pipe")]);
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the read it exists for", () => {
  test("a PNG the person owns comes back as its bytes", async () => {
    const answer = await readKittyImageFile(at("logo.png"));
    expect(answer.ok).toBe(true);
    expect(Buffer.from(answer.bytes).equals(PNG)).toBe(true);
  });

  test("a symlink to that PNG resolves and is read", async () => {
    const answer = await readKittyImageFile(at("link-to-logo.png"));
    expect(answer.ok).toBe(true);
  });
});

describe("each refusal, and its bare code", () => {
  const refused = async (requested, code, options) => {
    const answer = await readKittyImageFile(requested, options);
    expect(answer).toEqual({ ok: false, code });
    expect(answer.code).toMatch(/^E[A-Z]+$/);
  };

  test("a relative path", () => refused("logo.png", "EINVAL"));
  test("a path carrying a NUL", () => refused(`${at("logo.png")}\0.txt`, "EINVAL"));
  test("something that is not a string", () => refused({ path: "/x" }, "EINVAL"));
  test("a file that does not exist", () => refused(at("missing.png"), "ENOENT"));
  test("a directory", () => refused(at("folder"), "EINVAL"));
  test("a symlink to a directory — checked after it resolves", () => refused(at("link-to-folder"), "EINVAL"));
  test("a FIFO, without hanging on it", () => refused(at("pipe"), "EINVAL"));
  test("/dev by name", () => refused("/dev/null", "EPERM"));
  test("/dev reached through a symlink — refused after resolving", () => refused(at("link-to-dev-null"), "EPERM"));
  test("/proc and /sys by name, whether or not this OS has them", async () => {
    await refused("/proc/self/environ", "EPERM");
    await refused("/sys/kernel/notes", "EPERM");
    await refused("/tmp/../proc/self/environ", "EPERM");
  });
  test("a file over the size cap", () => refused(at("big.png"), "EFBIG", { limit: 64 }));
  test("a file that is not a PNG", () => refused(at("notes.txt"), "EBADPNG"));

  test("a link swapped in after the resolve is refused on the descriptor, not followed", async () => {
    fs.symlinkSync("/dev/null", at("swapped"));
    const fsp = { ...fs.promises, realpath: async () => at("swapped") };
    await refused(at("logo.png"), "ENOENT", { fsp });
  });
});

describe("the location rule", () => {
  test("matches the three roots and what is under them, in any case, and nothing that merely starts alike", () => {
    for (const hit of ["/dev", "/dev/null", "/proc/1/mem", "/sys/class", "/DEV/null", "/Proc/self"]) expect(isForbiddenLocation(hit)).toBe(true);
    for (const miss of ["/device/logo.png", "/process.png", "/system/logo.png", "/Users/me/dev/logo.png"]) expect(isForbiddenLocation(miss)).toBe(false);
  });
});
