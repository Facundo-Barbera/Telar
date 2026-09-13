// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
// Named for the deprecated convention; it is the matcher-testing util Next 16 ships.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";
import { addDevice, mintDeviceToken, setDeviceRole, setRequireAuth } from "@/lib/remote/store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];

function freshHome(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-proxy-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

function matches(url: string): boolean {
  return unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });
}

describe("pairing proxy", () => {
  test("the matcher covers /api and pages, sparing /pair and static assets", () => {
    expect(matches("/api/health")).toBe(true);
    expect(matches("/api/sessions/live")).toBe(true);
    expect(matches("/")).toBe(true);
    expect(matches("/settings")).toBe(true);
    expect(matches("/pair")).toBe(false);
    expect(matches("/_next/static/x.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
  });

  test("an unpaired person is redirected to /pair, not shown a 401", () => {
    freshHome();
    setRequireAuth(true);
    const response = proxy(new NextRequest("http://cockpit.test/settings"));
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("http://cockpit.test/pair");
  });

  test("no-op while requireAuth is off", () => {
    // Stated rather than inherited: a fresh store requires pairing now (#357),
    // so "off" is a thing this cockpit was switched to.
    freshHome();
    setRequireAuth(false);
    expect(proxy(new NextRequest("http://cockpit.test/api/health"))).toBeUndefined();
  });

  test("refuses an unpaired call with the standard error body", async () => {
    freshHome();
    setRequireAuth(true);
    const response = proxy(new NextRequest("http://cockpit.test/api/health"));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({
      error: { code: "cockpit_unauthorized", message: "Pair this device with the Telar cockpit to use it." },
    });
  });

  test("admits a paired bearer and notices revocation despite the cache", () => {
    freshHome();
    setRequireAuth(true);
    const raw = mintDeviceToken();
    addDevice("Phone", raw);
    const authed = new NextRequest("http://cockpit.test/api/health", {
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(proxy(authed)).toBeUndefined();
    // The write above moved remote.json's mtime; the next call re-reads.
    setRequireAuth(true); // rewrites the file with the device intact
    expect(proxy(authed)).toBeUndefined();
  });

  test("an observer reads freely, is 403'd on writes, and is never bounced to /pair", async () => {
    freshHome();
    const raw = mintDeviceToken();
    const full = mintDeviceToken();
    const phone = addDevice("Phone", raw);
    addDevice("Mac", full); // keeps a full device so the demotion is legal
    setRequireAuth(true);
    setDeviceRole(phone.id, "observer");

    const read = new NextRequest("http://cockpit.test/api/health", { headers: { authorization: `Bearer ${raw}` } });
    expect(proxy(read)).toBeUndefined();

    const write = new NextRequest("http://cockpit.test/api/sessions/x/turns", {
      method: "POST",
      headers: { authorization: `Bearer ${raw}` },
    });
    const denied = proxy(write);
    expect(denied?.status).toBe(403);
    expect(((await denied?.json()) as { error: { code: string } }).error.code).toBe("cockpit_forbidden");

    // A paired observer loading a page is a GET — allowed, no redirect.
    expect(proxy(new NextRequest("http://cockpit.test/settings", { headers: { authorization: `Bearer ${raw}` } }))).toBeUndefined();
  });

  test("fails open outside the launcher (ordinary web mode)", () => {
    delete process.env.TELAR_COCKPIT;
    expect(proxy(new NextRequest("http://cockpit.test/api/health"))).toBeUndefined();
  });
});
