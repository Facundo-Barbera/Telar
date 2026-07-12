// M5 HTTP transport — verb→request mapping, bearer token, error surfacing, via
// an injected fetchFn. No socket opens.
import { describe, expect, test } from "bun:test";
import { makeHttpTransport, type FetchFn } from "../src/runner/http-transport";

type Captured = { url: string; init?: RequestInit };

function recorder(response: (c: Captured) => Response): { fetchFn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    return response(c);
  };
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const bodyOf = (c: Captured) => JSON.parse(String(c.init!.body));
const authOf = (c: Captured) => (c.init!.headers as Record<string, string>).authorization;

describe("makeHttpTransport", () => {
  test("GET /health and /active carry the bearer token", async () => {
    const { fetchFn, calls } = recorder(() => json({ pid: 1, version: "v", ok: true }));
    const t = makeHttpTransport({ baseUrl: "http://127.0.0.1:9000/", token: "TOK", fetchFn });
    await t.health();
    expect(calls[0].url).toBe("http://127.0.0.1:9000/health");
    expect(calls[0].init!.method).toBe("GET");
    expect(authOf(calls[0])).toBe("Bearer TOK");

    await t.getActive();
    expect(calls[1].url).toBe("http://127.0.0.1:9000/active");
  });

  test("dispatch verbs POST /dispatch/loom with the right verb payload", async () => {
    const { fetchFn, calls } = recorder(() => json({ id: "L1" }));
    const t = makeHttpTransport({ baseUrl: "http://127.0.0.1:9000", token: "TOK", fetchFn });

    await t.start({ project: "p", kind: "custom", title: "t", prompt: "x" });
    expect(calls[0].url).toBe("http://127.0.0.1:9000/dispatch/loom");
    expect(calls[0].init!.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ verb: "start", input: { project: "p", kind: "custom", title: "t", prompt: "x" } });
    expect(authOf(calls[0])).toBe("Bearer TOK");

    await t.startFromBundle("b1", "alice", { maxAttempts: 3 });
    expect(bodyOf(calls[1])).toEqual({ verb: "startFromBundle", loomId: "b1", by: "alice", opts: { maxAttempts: 3 } });

    await t.approveCharter("c1", "bob");
    expect(bodyOf(calls[2])).toEqual({ verb: "approveCharter", id: "c1", by: "bob" });

    await t.steer("s1", "go", "carol");
    expect(bodyOf(calls[3])).toEqual({ verb: "steer", id: "s1", directive: "go", by: "carol" });

    await t.reject("r1", "nope", "dave");
    expect(bodyOf(calls[4])).toEqual({ verb: "reject", id: "r1", feedback: "nope", by: "dave" });

    await t.resume("z1");
    expect(bodyOf(calls[5])).toEqual({ verb: "resume", id: "z1" });
  });

  test("cancel POSTs /stop/loom", async () => {
    const { fetchFn, calls } = recorder(() => json(true));
    const t = makeHttpTransport({ baseUrl: "http://127.0.0.1:9000", token: "TOK", fetchFn });
    await t.cancel("k1");
    expect(calls[0].url).toBe("http://127.0.0.1:9000/stop/loom");
    expect(bodyOf(calls[0])).toEqual({ id: "k1" });
  });

  test("a non-ok response surfaces the runner's error text", async () => {
    const { fetchFn } = recorder(() => json({ error: "boom" }, 500));
    const t = makeHttpTransport({ baseUrl: "http://127.0.0.1:9000", token: "TOK", fetchFn });
    await expect(t.resume("z1")).rejects.toThrow(/runner POST \/dispatch\/loom failed: 500/);
  });
});
