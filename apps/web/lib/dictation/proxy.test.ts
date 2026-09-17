/**
 * THE PHONE'S ROUTE TO A TOKEN (#544).
 *
 * The phone does not hold an engine bearer and does not hold the Deepgram key.
 * It reaches `POST /api/dictation/token` on the Mac it is paired to, and when
 * that Mac is a REMOTE one it goes through `/api/hosts/:id/*`, which forwards
 * any path to that Mac's `/api/*` with its own bearer.
 *
 * WHAT IS BEING CHECKED IS THAT NOTHING HAD TO BE ADDED. The host proxy is
 * path-agnostic on purpose, so a new route is reachable the day it exists — but
 * "on purpose" is a claim, and this file is what holds it: the POST arrives as
 * a POST, the token comes back intact, and the dictation route is not
 * accidentally inside the rail's ten-second polling budget.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { forward, upstreamTimeout, upstreamUrl } from "@/lib/hosts/proxy";

const host = { id: "host_b", name: "mini", baseUrl: "http://mini:3000", deviceToken: "tlr_remote" };

function fake(answer: (input: string, init: RequestInit) => Response): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => answer(String(input), init ?? {})) as typeof fetch;
}

describe("a dictation token through the host proxy", () => {
  test("the path maps to the other Mac's own route, with no allowlist to keep up to date", () => {
    expect(upstreamUrl(host, ["dictation", "token"], "")).toBe("http://mini:3000/api/dictation/token");
    expect(upstreamUrl(host, ["dictation"], "")).toBe("http://mini:3000/api/dictation");
  });

  test("the POST arrives as a POST, with that Mac's bearer and not this one's", async () => {
    let seen: RequestInit | undefined;
    const request = new Request("http://cockpit.local/api/hosts/host_b/dictation/token", {
      method: "POST",
      headers: { authorization: "Bearer tlr_local", cookie: "telar_device=abc" },
    });
    const response = await forward(
      request,
      host,
      ["dictation", "token"],
      fake((url, init) => {
        seen = init;
        expect(url).toBe("http://mini:3000/api/dictation/token");
        return Response.json({ provider: "deepgram", token: "jwt-abc", expiresAt: 1_700_000_000_000 });
      }),
    );

    expect(seen!.method).toBe("POST");
    const headers = new Headers(seen!.headers);
    expect(headers.get("authorization")).toBe("Bearer tlr_remote");
    // This cockpit's own device credential names a device of THIS cockpit and
    // would be nonsense — or a leak — over there.
    expect(headers.get("cookie")).toBeNull();
    // The token survives the hop whole: a phone that got a truncated JWT would
    // fail at the Deepgram handshake with nothing explaining why.
    expect(await response.json()).toEqual({ provider: "deepgram", token: "jwt-abc", expiresAt: 1_700_000_000_000 });
  });

  test("a refusal from the other Mac arrives as itself, sentence and all", async () => {
    const response = await forward(
      new Request("http://cockpit.local/api/hosts/host_b/dictation/token", { method: "POST" }),
      host,
      ["dictation", "token"],
      fake(() => Response.json({ error: { code: "conflict", message: "No Deepgram key is configured on this Mac…" } }, { status: 409 })),
    );
    expect(response.status).toBe(409);
    // "That Mac has no key" has to survive as that, not as a generic failure:
    // it is the one refusal the person can actually act on, and it names the
    // machine to act on it from.
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("No Deepgram key is configured");
  });

  test("minting a token is not on the rail's ten-second leash", () => {
    // The rail's polling reads are bounded because a hung Mac must not cost a
    // reader a minute. A token grant is a POST and reaches another service;
    // bounding it on the reader's patience would be the wrong trade.
    expect(upstreamTimeout({ method: "POST" }, ["dictation", "token"])).toBe(60_000);
  });
});
