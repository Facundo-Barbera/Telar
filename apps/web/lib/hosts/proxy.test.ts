// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { forward, upstreamTimeout, upstreamUrl, HOST_ID_HEADER } from "./proxy";
import { HOST_NAME_HEADER } from "./client";
import { HOST_HEADER } from "@/lib/remote/host-token";

const host = { id: "host_b", name: "mini", baseUrl: "http://mini:3000", deviceToken: "tlr_remote" };

function fake(answer: (input: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => answer(String(input), init ?? {})) as typeof fetch;
}

describe("upstreamUrl", () => {
  test("the path segments, encoded, under the remote's /api, query kept", () => {
    expect(upstreamUrl(host, ["sessions", "s 1", "turns"], "?after=3")).toBe("http://mini:3000/api/sessions/s%201/turns?after=3");
  });
});

describe("upstreamTimeout", () => {
  test("the rail's polling pass waits ten seconds, not sixty", () => {
    for (const path of [["sessions", "live"], ["health"], ["inbox"], ["projects"]]) {
      expect([path, upstreamTimeout({ method: "GET" }, path)]).toEqual([path, 10_000]);
    }
  });

  test("everything else keeps the minute — a diff and an icon are slow for honest reasons", () => {
    expect(upstreamTimeout({ method: "GET" }, ["sessions", "s1", "diff"])).toBe(60_000);
    expect(upstreamTimeout({ method: "GET" }, ["projects", "p1", "icon"])).toBe(60_000);
    expect(upstreamTimeout({ method: "GET" }, ["attachments", "a1"])).toBe(60_000);
  });

  test("a write is never a list read, whatever it is addressed to", () => {
    // `PATCH /inbox` shares its path with the rail's read of the same document;
    // bounding a write on the reader's patience would be the wrong trade.
    expect(upstreamTimeout({ method: "PATCH" }, ["inbox"])).toBe(60_000);
    expect(upstreamTimeout({ method: "POST" }, ["projects"])).toBe(60_000);
    expect(upstreamTimeout({ method: "get" }, ["health"])).toBe(10_000);
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
    // …and it NAMES the Mac, in the body and in the header, because "that Mac"
    // is unanswerable on a cockpit paired with three (#204).
    expect(response.headers.get(HOST_NAME_HEADER)).toBe("mini");
  });
});

/**
 * WHOSE ANSWER THIS IS (#204). A 404 carried back faithfully is otherwise
 * indistinguishable from one this Mac minted, and a session id means nothing
 * without the engine that minted it.
 */
describe("the answer says which Mac gave it", () => {
  test("every forwarded answer carries the host's name and id", async () => {
    const request = new Request("http://cockpit.local/api/hosts/h/sessions/session_shared");
    const response = await forward(request, host, ["sessions", "session_shared"], fake(() =>
      Response.json({ error: { code: "not_found", message: "session does not exist" } }, { status: 404 }),
    ));
    expect(response.status).toBe(404);
    expect(response.headers.get(HOST_NAME_HEADER)).toBe("mini");
    expect(response.headers.get(HOST_ID_HEADER)).toBe("host_b");
  });

  test("a remote cannot name itself — the book's word wins over the wire's", async () => {
    // Otherwise the other end could put any name on an error this cockpit then
    // shows as fact.
    const request = new Request("http://cockpit.local/api/hosts/h/projects");
    const response = await forward(request, host, ["projects"], fake(() =>
      Response.json({ projects: [] }, { headers: { [HOST_NAME_HEADER]: "your own Mac", [HOST_ID_HEADER]: "local" } }),
    ));
    expect(response.headers.get(HOST_NAME_HEADER)).toBe("mini");
    expect(response.headers.get(HOST_ID_HEADER)).toBe("host_b");
  });
});
