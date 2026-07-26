// AC9's proof, with NO DOM, no network and no server.
//
// `Response` is a global in bun, so every branch of the helper is reachable from
// a hand-built response object. That is the same move that makes this whole
// story testable in a repo with no component harness: push the logic into a pure
// function and the missing harness stops mattering.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readPreStreamError } from "./pre-stream-error";

describe("readPreStreamError — the dock stops swallowing a pre-SSE 400", () => {
  test("an OK response has no error to surface", async () => {
    expect(await readPreStreamError(new Response("", { status: 200 }))).toBeNull();
    expect(await readPreStreamError(new Response('{"error":"ignored"}', { status: 200 }))).toBeNull();
    // 2xx generally, not just 200 — `ok` is the guard, not an equality.
    expect(await readPreStreamError(new Response(null, { status: 204 }))).toBeNull();
  });

  test("a 400 carrying {error} returns THAT SENTENCE — the server's own words", async () => {
    const res = new Response('{"error":"Escalation sessions may not write."}', { status: 400 });
    expect(await readPreStreamError(res)).toBe("Escalation sessions may not write.");
  });

  test("a 400 whose body is not JSON returns a STATUS-BEARING line, never undefined", async () => {
    const got = await readPreStreamError(new Response("<html>nope</html>", { status: 400 }));
    expect(got).toBe("HTTP 400");
    expect(got).not.toBeUndefined();
  });

  test("a 400 with a JSON body that carries no `error` falls back to the status line", async () => {
    expect(await readPreStreamError(new Response("{}", { status: 400 }))).toBe("HTTP 400");
    expect(await readPreStreamError(new Response('{"error":123}', { status: 400 }))).toBe("HTTP 400");
    // An empty or whitespace-only sentence is not a sentence.
    expect(await readPreStreamError(new Response('{"error":"   "}', { status: 400 }))).toBe(
      "HTTP 400",
    );
    // A null body parses fine and carries no `error`.
    expect(await readPreStreamError(new Response("null", { status: 400 }))).toBe("HTTP 400");
  });

  test("a body that REJECTS on .json() degrades to the status line and never rethrows", async () => {
    // This is the branch that matters most: the helper runs on the failure path,
    // where a second failure has nowhere to go. A rethrow here would replace one
    // silent loss with a different silent loss.
    const hostile = {
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error("body already consumed")),
    } as unknown as Response;
    expect(await readPreStreamError(hostile)).toBe("HTTP 503");
  });

  test("a body that throws SYNCHRONOUSLY on .json() is caught too", async () => {
    const hostile = {
      ok: false,
      status: 500,
      json: () => {
        throw new Error("nope");
      },
    } as unknown as Response;
    expect(await readPreStreamError(hostile)).toBe("HTTP 500");
  });

  test("the status is carried verbatim, so the fallback can never read as a success", async () => {
    for (const status of [400, 401, 403, 409, 429, 500, 502]) {
      expect(await readPreStreamError(new Response("nope", { status }))).toBe(`HTTP ${status}`);
    }
  });
});
