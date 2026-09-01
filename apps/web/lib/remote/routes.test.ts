// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as pingGet } from "@/app/api/ping/route";
import { POST as pairPost } from "@/app/api/pair/route";
import { GET as remoteGet, PATCH as remotePatch } from "@/app/api/remote/route";
import { POST as pairingMint } from "@/app/api/remote/pairing/route";
import { DELETE as deviceDelete, PATCH as devicePatch } from "@/app/api/remote/devices/[deviceId]/route";
import { DELETE as devicesDeleteOthers } from "@/app/api/remote/devices/route";
import { decideApiAccess } from "./gate";
import { isTailnetIpv4, listEndpoints } from "./endpoints";
import { readRemote } from "./store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];

function freshHome(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-remote-routes-"));
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

async function mintToken(): Promise<string> {
  const minted = (await pairingMint().json()) as { token: string };
  return minted.token;
}

function pairRequest(token: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Request {
  return new Request("http://cockpit.test/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token, deviceName: "Test phone", ...extra }),
  });
}

function statusRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://cockpit.test/api/remote", { headers });
}

function patchDeviceRequest(deviceId: string, body: Record<string, unknown>) {
  return devicePatch(
    new Request("http://x/api/remote/devices/" + deviceId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ deviceId }) },
  );
}

describe("pairing routes", () => {
  test("ping answers strangers with the version signature, even while the gate is on", async () => {
    freshHome();
    const { EXEMPT_API_PATHS } = await import("./gate");
    expect(EXEMPT_API_PATHS.has("/api/ping")).toBe(true);
    const body = (await pingGet().json()) as { ok: boolean; proto: number; appVersion: string };
    expect(body.ok).toBe(true);
    expect(body.proto).toBe(1);
    expect(typeof body.appVersion).toBe("string");
  });

  test("mint → exchange yields a device token and a lax http cookie", async () => {
    freshHome();
    const response = await pairPost(pairRequest(await mintToken()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deviceToken: string; deviceId: string };
    expect(body.deviceToken).toMatch(/^tlr_/);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("telar_device=tlr_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie.includes("Secure")).toBe(false);
    // And the minted device actually admits requests.
    expect(decideApiAccess(
      { pathname: "/api/health", method: "GET", authorization: `Bearer ${body.deviceToken}`, deviceCookie: null },
      { ...readRemote(), requireAuth: true },
    )).toEqual({ allow: true, deviceId: body.deviceId, role: "full" });
  });

  test("an https-forwarded exchange marks the cookie Secure", async () => {
    freshHome();
    const response = await pairPost(pairRequest(await mintToken(), { "x-forwarded-proto": "https" }));
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  test("a replayed pairing token is refused", async () => {
    freshHome();
    const token = await mintToken();
    expect((await pairPost(pairRequest(token))).status).toBe(200);
    const replay = await pairPost(pairRequest(token));
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("cockpit_unauthorized");
  });

  test("the status body never carries token material", async () => {
    freshHome();
    await mintToken();
    await pairPost(pairRequest(await mintToken()));
    const serialized = JSON.stringify(await remoteGet(statusRequest()).json());
    expect(serialized.includes("tokenHash")).toBe(false);
    expect(serialized.includes("tlr_")).toBe(false);
  });

  test("the status names the calling device, by bearer or by cookie, and strangers get nothing", async () => {
    freshHome();
    const paired = (await (await pairPost(pairRequest(await mintToken(), {}, { platform: "ios" }))).json()) as {
      deviceToken: string;
      deviceId: string;
    };
    const byBearer = (await remoteGet(statusRequest({ authorization: `Bearer ${paired.deviceToken}` })).json()) as {
      callerDeviceId?: string;
      callerRole?: string;
      devices: { id: string; platform?: string }[];
    };
    expect(byBearer.callerDeviceId).toBe(paired.deviceId);
    expect(byBearer.callerRole).toBe("full");
    expect(byBearer.devices[0].platform).toBe("ios");

    const byCookie = (await remoteGet(statusRequest({ cookie: `telar_device=${paired.deviceToken}` })).json()) as {
      callerDeviceId?: string;
    };
    expect(byCookie.callerDeviceId).toBe(paired.deviceId);

    const stranger = (await remoteGet(statusRequest()).json()) as { callerDeviceId?: string };
    expect(stranger.callerDeviceId).toBeUndefined();
  });

  test("PATCH renames and re-roles a device; demoting the last full one is 409", async () => {
    freshHome();
    const paired = (await (await pairPost(pairRequest(await mintToken()))).json()) as { deviceId: string };
    const renamed = await patchDeviceRequest(paired.deviceId, { name: "  The phone  " });
    expect(((await renamed.json()) as { device: { name: string } }).device.name).toBe("The phone");

    const other = (await (await pairPost(pairRequest(await mintToken()))).json()) as { deviceId: string };
    await remotePatch(new Request("http://x/api/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAuth: true }),
    }));
    // Three full devices now (two paired + the self-paired browser); demote two.
    expect((await patchDeviceRequest(other.deviceId, { role: "observer" })).status).toBe(200);
    const browserDevice = readRemote().devices.find((device) => device.name === "This browser")!;
    expect((await patchDeviceRequest(browserDevice.id, { role: "observer" })).status).toBe(200);
    const last = await patchDeviceRequest(paired.deviceId, { role: "observer" });
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("cockpit_last_full_device");

    expect((await patchDeviceRequest(paired.deviceId, {})).status).toBe(400);
    expect((await patchDeviceRequest("dev_missing", { name: "Ghost" })).status).toBe(404);
  });

  test("DELETE /api/remote/devices keeps the caller and revokes the rest", async () => {
    freshHome();
    const keeper = (await (await pairPost(pairRequest(await mintToken()))).json()) as { deviceToken: string; deviceId: string };
    await pairPost(pairRequest(await mintToken()));
    await pairPost(pairRequest(await mintToken()));
    const anonymous = devicesDeleteOthers(new Request("http://x/api/remote/devices", { method: "DELETE" }));
    expect(anonymous.status).toBe(401);
    const response = devicesDeleteOthers(
      new Request("http://x/api/remote/devices", {
        method: "DELETE",
        headers: { authorization: `Bearer ${keeper.deviceToken}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { revoked: number }).revoked).toBe(2);
    expect(readRemote().devices.map((device) => device.id)).toEqual([keeper.deviceId]);
  });

  test("the self-paired browser is stamped as a browser", async () => {
    freshHome();
    await remotePatch(new Request("http://x/api/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAuth: true }),
    }));
    expect(readRemote().devices[0].platform).toBe("browser");
  });

  test("enabling requireAuth pairs the calling browser in the same response", async () => {
    freshHome();
    const response = await remotePatch(new Request("http://cockpit.test/api/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireAuth: true }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("telar_device=tlr_");
    expect(readRemote().requireAuth).toBe(true);
    expect(readRemote().devices).toHaveLength(1);
  });

  test("revoking a device removes its access", async () => {
    freshHome();
    const paired = (await (await pairPost(pairRequest(await mintToken()))).json()) as {
      deviceToken: string;
      deviceId: string;
    };
    const gone = await deviceDelete(new Request("http://x/api/remote/devices/" + paired.deviceId, { method: "DELETE" }), {
      params: Promise.resolve({ deviceId: paired.deviceId }),
    });
    expect(gone.status).toBe(200);
    expect(decideApiAccess(
      { pathname: "/api/health", method: "GET", authorization: `Bearer ${paired.deviceToken}`, deviceCookie: null },
      { ...readRemote(), requireAuth: true },
    )).toEqual({ allow: false, code: "cockpit_unauthorized" });
  });

  test("an oversized pair body is refused before parsing", async () => {
    freshHome();
    const response = await pairPost(new Request("http://x/api/pair", {
      method: "POST",
      body: "x".repeat(2048),
    }));
    expect(response.status).toBe(400);
  });
});

describe("endpoint enumeration", () => {
  const nics = {
    lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    en0: [
      { family: "IPv4", address: "192.168.1.20", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
    ],
    utun3: [{ family: "IPv4", address: "100.110.136.102", internal: false }],
    awdl0: [{ family: "IPv4", address: "169.254.10.10", internal: false }],
  };

  test("classifies tailnet vs lan and never marks loopback qrSafe", () => {
    const endpoints = listEndpoints(3000, nics, {});
    expect(endpoints.map((endpoint) => [endpoint.kind, endpoint.qrSafe])).toEqual([
      ["loopback", false],
      ["lan", true],
      ["tailnet", true],
    ]);
    expect(endpoints[2].url).toBe("http://100.110.136.102:3000");
  });

  test("the magicdns endpoint appears only via the launcher env, https only", () => {
    expect(listEndpoints(3000, nics, { TELAR_TAILSCALE_URL: "https://mac.tail.ts.net/" }).at(-1)).toEqual({
      kind: "magicdns",
      label: "Tailscale HTTPS",
      url: "https://mac.tail.ts.net",
      qrSafe: true,
    });
    expect(listEndpoints(3000, nics, { TELAR_TAILSCALE_URL: "http://mac.tail.ts.net" }).some((endpoint) => endpoint.kind === "magicdns")).toBe(false);
  });

  test("the CGNAT range is exactly 100.64/10", () => {
    expect(isTailnetIpv4("100.64.0.1")).toBe(true);
    expect(isTailnetIpv4("100.127.255.254")).toBe(true);
    expect(isTailnetIpv4("100.63.0.1")).toBe(false);
    expect(isTailnetIpv4("100.128.0.1")).toBe(false);
    expect(isTailnetIpv4("10.0.0.1")).toBe(false);
  });
});
