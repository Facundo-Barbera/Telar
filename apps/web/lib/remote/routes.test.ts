// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POST as pairPost } from "@/app/api/pair/route";
import { GET as remoteGet, PATCH as remotePatch } from "@/app/api/remote/route";
import { POST as pairingMint } from "@/app/api/remote/pairing/route";
import { DELETE as deviceDelete } from "@/app/api/remote/devices/[deviceId]/route";
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

function pairRequest(token: string, headers: Record<string, string> = {}): Request {
  return new Request("http://cockpit.test/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token, deviceName: "Test phone" }),
  });
}

describe("pairing routes", () => {
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
      { pathname: "/api/health", authorization: `Bearer ${body.deviceToken}`, deviceCookie: null },
      { ...readRemote(), requireAuth: true },
    )).toEqual({ allow: true, deviceId: body.deviceId });
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
    const serialized = JSON.stringify(await remoteGet().json());
    expect(serialized.includes("tokenHash")).toBe(false);
    expect(serialized.includes("tlr_")).toBe(false);
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
      { pathname: "/api/health", authorization: `Bearer ${paired.deviceToken}`, deviceCookie: null },
      { ...readRemote(), requireAuth: true },
    )).toEqual({ allow: false });
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
