// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { forward, upstreamUrl } from "./proxy";
import { HOST_HEADER } from "@/lib/remote/host-token";

const host = { baseUrl: "http://mini:3000", deviceToken: "tlr_remote" };

function fake(answer: (input: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => answer(String(input), init ?? {})) as typeof fetch;
}

describe("upstreamUrl", () => {
  test("the path segments, encoded, under the remote's /api, query kept", () => {
    expect(upstreamUrl(host, ["sessions", "s 1", "turns"], "?after=3")).toBe("http://mini:3000/api/sessions/s%201/turns?after=3");
  });
});

describe("forward", () => {
  test("adds the remote's bearer and drops this cockpit's own credentials", async () => {
    let seen: RequestInit | undefined;
    const request = new Request("http://cockpit.local/api/hosts/h/projects?x=1", {
      headers: {
        authorization: "Bearer tlr_local",
        cookie: "telar_device=abc",
        [HOST_HEADER]: "tlr_thismachineshostsecret",
        "content-type": "application/json",
        "x-telar-attachment-name": "a.png",
      },
    });
    const response = await forward(request, host, ["projects"], fake((url, init) => {
      seen = init;
      expect(url).toBe("http://mini:3000/api/projects?x=1");
      return Response.json({ projects: [] }, { headers: { "set-cookie": "telar_device=leak", etag: "W/1" } });
    }));
    const headers = new Headers(seen!.headers);
    expect(headers.get("authorization")).toBe("Bearer tlr_remote");
    expect(headers.get("cookie")).toBeNull();
    // The desktop shell puts its launcher secret on every request to THIS
    // cockpit; forwarding it would hand this machine's credential to another.
    expect(headers.get(HOST_HEADER)).toBeNull();
    expect(headers.get("x-telar-attachment-name")).toBe("a.png");
    // The remote pairs a device; this cockpit does not become one.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("etag")).toBe("W/1");
    expect(await response.json()).toEqual({ projects: [] });
  });

  test("status and body pass through, so a remote 404 is a 404 here", async () => {
    const request = new Request("http://cockpit.local/api/hosts/h/sessions/nope");
    const response = await forward(request, host, ["sessions", "nope"], fake(() => Response.json({ error: { code: "not_found" } }, { status: 404 })));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found" } });
  });

  test("a POST carries its body and method", async () => {
    let seen: RequestInit | undefined;
    const request = new Request("http://cockpit.local/api/hosts/h/sessions/s/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    await forward(request, host, ["sessions", "s", "turns"], fake(async (_url, init) => {
      seen = init;
      // Drain what the proxy handed over, as the network would.
      const body = await new Response(init.body as BodyInit).text();
      expect(body).toBe(JSON.stringify({ input: "hi" }));
      return Response.json({ ok: true });
    }));
    expect(seen!.method).toBe("POST");
  });

  test("a Mac that does not answer is 'engine_unavailable', like a local engine that is down", async () => {
    const request = new Request("http://cockpit.local/api/hosts/h/projects");
    const response = await forward(request, host, ["projects"], fake(() => {
      throw new TypeError("fetch failed");
    }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("engine_unavailable");
  });
});
