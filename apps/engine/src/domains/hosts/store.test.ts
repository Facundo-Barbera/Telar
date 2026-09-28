import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostsStore, publicHost } from "./store";

const roots: string[] = [];

function freshStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-"));
  roots.push(home);
  return createHostsStore(path.join(home, "remote"));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("the hosts book on disk", () => {
  test("is private and starts empty", () => {
    const store = freshStore();
    expect(store.read()).toEqual({ version: 1, hosts: [] });
    const host = store.add({ baseUrl: "http://mini:3000", deviceToken: "tlr_a", name: "Mini", daemonId: "d1" });
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    expect(store.find(host.id)).toMatchObject({ name: "Mini", baseUrl: "http://mini:3000", deviceToken: "tlr_a", daemonId: "d1" });
  });

  test("the public shape carries no token", () => {
    const host = freshStore().add({ baseUrl: "http://mini:3000", deviceToken: "tlr_a" });
    expect(Object.keys(publicHost(host))).not.toContain("deviceToken");
  });

  test("the same Mac at a second address folds into one row by its daemonId", () => {
    const store = freshStore();
    const first = store.add({ baseUrl: "http://mini:3000", deviceToken: "tlr_a", daemonId: "d1" });
    store.add({ baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b", daemonId: "d1" });
    const hosts = store.read().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: first.id, baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b" });
  });

  test("rename and forget", () => {
    const store = freshStore();
    const host = store.add({ baseUrl: "http://mini:3000", deviceToken: "tlr_a" });
    expect(store.rename(host.id, "Studio")?.name).toBe("Studio");
    expect(store.rename("nope", "x")).toBeUndefined();
    expect(store.remove(host.id)).toBe(true);
    expect(store.remove(host.id)).toBe(false);
    expect(store.read().hosts).toEqual([]);
  });
});
