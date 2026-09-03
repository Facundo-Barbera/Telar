// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addHost, findHost, hostsPath, learnDaemonId, publicHost, readHosts, removeStoredHost, renameStoredHost } from "./store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

describe("the hosts book on disk", () => {
  test("lives beside the pairing store, private, and starts empty", () => {
    const home = freshHome();
    // realpath'd like the pairing store's own home: on macOS the tmpdir is
    // a symlink into /private, and the store canonicalizes it.
    expect(hostsPath()).toBe(path.join(fs.realpathSync.native(home), "remote", "hosts.json"));
    expect(readHosts()).toEqual({ version: 1, hosts: [] });
    const host = addHost({ baseUrl: "http://mini:3000", deviceToken: "tlr_a", name: "Mini", daemonId: "d1" });
    expect(fs.statSync(hostsPath()).mode & 0o777).toBe(0o600);
    expect(findHost(host.id)).toMatchObject({ name: "Mini", baseUrl: "http://mini:3000", deviceToken: "tlr_a", daemonId: "d1" });
  });

  // The browser gets everything but the token: the token is what the proxy
  // is for, and a renderer that held it would be a renderer that could leak it.
  test("the public shape carries no token", () => {
    freshHome();
    const host = addHost({ baseUrl: "http://mini:3000", deviceToken: "tlr_a" });
    expect(Object.keys(publicHost(host))).not.toContain("deviceToken");
  });

  test("the same Mac at a second address folds into one row when its daemonId is learned", () => {
    freshHome();
    const first = addHost({ baseUrl: "http://mini:3000", deviceToken: "tlr_a", daemonId: "d1" });
    const second = addHost({ baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b" });
    expect(readHosts().hosts).toHaveLength(2);
    learnDaemonId(second.id, "d1");
    const hosts = readHosts().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: first.id, baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b" });
  });

  test("rename and forget", () => {
    freshHome();
    const host = addHost({ baseUrl: "http://mini:3000", deviceToken: "tlr_a" });
    expect(renameStoredHost(host.id, "Studio")?.name).toBe("Studio");
    expect(renameStoredHost("nope", "x")).toBeUndefined();
    expect(removeStoredHost(host.id)).toBe(true);
    expect(removeStoredHost(host.id)).toBe(false);
    expect(readHosts().hosts).toEqual([]);
  });
});
