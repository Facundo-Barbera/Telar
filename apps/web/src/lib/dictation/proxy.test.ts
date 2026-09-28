// The phone reaches a remote Mac's `POST /api/dictation/token` through the
// path-agnostic host proxy; nothing dictation-specific is added to it.
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { forward, upstreamTimeout, upstreamUrl } from "@/lib/hosts/proxy";

const host = { id: "host_b", name: "mini", baseUrl: "http://mini:3000", deviceToken: "tlr_remote" };

function fake(answer: (input: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
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
    // This cockpit's device credential would be a leak on another Mac.
    expect(headers.get("cookie")).toBeNull();
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
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("No Deepgram key is configured");
  });

  test("minting a token is not on the rail's ten-second leash", () => {
    // Polling reads are bounded short; a token grant is a POST to another service.
    expect(upstreamTimeout({ method: "POST" }, ["dictation", "token"])).toBe(60_000);
  });
});
