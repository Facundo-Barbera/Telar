// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRemote, remoteHome, RemoteStoreError, storePath } from "./store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-remote-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  return home;
}

function writeFile(content: unknown): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(content));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

describe("reading the remote store", () => {
  test("a missing file requires pairing", () => {
    freshHome();
    expect(readRemote()).toEqual({ version: 1, requireAuth: true, devices: [] });
  });

  test("remoteHome applies the launcher discipline", () => {
    delete process.env.TELAR_COCKPIT;
    process.env.TELAR_HOME = "/tmp/telar-x";
    expect(() => remoteHome()).toThrow(RemoteStoreError);

    process.env.TELAR_COCKPIT = "1";
    process.env.TELAR_HOME = "relative/home";
    expect(() => remoteHome()).toThrow("absolute TELAR_HOME");

    process.env.TELAR_HOME = path.join(os.homedir(), ".telar-dev");
    expect(() => remoteHome()).toThrow("legacy");
  });

  test("a file written before roles existed reads every device as full", () => {
    freshHome();
    writeFile({ version: 1, requireAuth: true, devices: [{ id: "dev_old", name: "Old phone", tokenHash: "ab".repeat(32), createdAt: 1 }] });
    expect(readRemote().devices[0]!.role).toBe("full");
  });

  test("an unknown version reads as open, unlike a missing file", () => {
    freshHome();
    writeFile({ version: 99, requireAuth: true, devices: [{}] });
    expect(readRemote()).toEqual({ version: 1, requireAuth: false, devices: [] });
  });

  test("anything but the widening value reads as loopback", () => {
    freshHome();
    writeFile({ version: 1, requireAuth: true, devices: [], exposure: "wide-open" });
    expect(readRemote().exposure).toBe("local-only");
  });
});
