// The proof for the OPTIONAL CLIProxyAPI gateway.
//
// Every network call is injected, so this suite never touches a real proxy and
// passes on a machine that has never heard of one. The response bodies are
// transcribed from a live instance (127.0.0.1:8317, v6.x) — the root probe, the
// OpenAI-compatible catalog, and the management API's auth-files listing.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-proxy-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
  // The breaker is module-level by design — it models a lockout that lives in
  // the PROXY, not in any one request. That makes it leak between tests, so
  // every test starts from closed unless it trips it itself.
  clearManagementBreaker();
});

const {
  readProxyConfig,
  writeProxyConfig,
  setProxyKey,
  getProxyKey,
  probeProxy,
  proxyModels,
  proxyUpstreams,
  proxyStatus,
  setUpstreamPrefix,
  clearManagementBreaker,
  managementBreakerState,
  proxyKeyShapeError,
  PROXY_DEFAULT_URL,
} = await import("../src/proxy");
const { accountEnv } = await import("../src/engine");
const { upsertAccount, getAccount, removeAccount, isMainAccount } = await import("../src/accounts");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A fetch stub that answers by path, so each test states only what it needs.
const stub = (routes: Record<string, { status?: number; body?: unknown }>) =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([p]) => u.endsWith(p));
    if (!hit) return new Response("not found", { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

const unreachable = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

const ROOT_OK = {
  "/": {
    body: {
      endpoints: ["POST /v1/chat/completions", "GET /v1/models"],
      message: "CLI Proxy API Server",
    },
  },
};

describe("config", () => {
  test("absent config is disabled, at the default URL", () => {
    const cfg = readProxyConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.url).toBe(PROXY_DEFAULT_URL);
  });

  test("writing normalizes a trailing slash and round-trips", () => {
    const saved = writeProxyConfig({ enabled: true, url: "http://127.0.0.1:8317/" });
    expect(saved.url).toBe("http://127.0.0.1:8317");
    expect(readProxyConfig()).toEqual({ enabled: true, url: "http://127.0.0.1:8317" });
  });

  test("keys live in the secret store, never in proxy.json", () => {
    setProxyKey("api", "sk-local-secret");
    setProxyKey("management", "mgmt-secret");
    expect(getProxyKey("api")).toBe("sk-local-secret");
    expect(getProxyKey("management")).toBe("mgmt-secret");
    const raw = fs.readFileSync(path.join(home, "proxy.json"), "utf8");
    expect(raw).not.toContain("sk-local-secret");
    expect(raw).not.toContain("mgmt-secret");
  });

  test("an empty value clears a key — the UI's only way to remove one", () => {
    setProxyKey("api", "temp");
    setProxyKey("api", "");
    expect(getProxyKey("api")).toBeUndefined();
    setProxyKey("api", "sk-local-secret"); // restore for later tests
  });
});

describe("probeProxy", () => {
  test("identifies a real CLIProxyAPI from its unauthenticated root", async () => {
    const r = await probeProxy("http://127.0.0.1:8317", stub(ROOT_OK));
    expect(r.reachable).toBe(true);
    expect(r.error).toBeNull();
  });

  test("something else answering 200 is NOT a proxy", async () => {
    // A dev server on the same port must not read as a working gateway.
    const r = await probeProxy("http://127.0.0.1:8317", stub({ "/": { body: { hello: "world" } } }));
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/isn't CLIProxyAPI/);
  });

  test("nothing listening is a reason, not a throw", async () => {
    const r = await probeProxy("http://127.0.0.1:8317", unreachable);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/is CLIProxyAPI running/);
  });
});

describe("proxyModels", () => {
  test("returns the catalog, which spans harnesses", async () => {
    // The point of the gateway: Claude and GPT models from one endpoint.
    const models = await proxyModels(
      "http://127.0.0.1:8317",
      "sk-local",
      stub({
        "/v1/models": {
          body: { data: [{ id: "claude-opus-4-6" }, { id: "gpt-5.4" }, { id: "gpt-image-2" }] },
        },
      }),
    );
    expect(models).toEqual(["claude-opus-4-6", "gpt-5.4", "gpt-image-2"]);
  });

  test("no API key means no request at all", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await proxyModels("http://127.0.0.1:8317", undefined, spy)).toEqual([]);
    expect(called).toBe(false);
  });

  test("a rejected key degrades to an empty catalog, not a throw", async () => {
    const models = await proxyModels(
      "http://127.0.0.1:8317",
      "wrong",
      stub({ "/v1/models": { status: 401, body: { error: "Missing API key" } } }),
    );
    expect(models).toEqual([]);
  });
});

describe("proxyUpstreams", () => {
  const POOL = {
    "/v0/management/auth-files": {
      body: {
        files: [
          {
            id: "claude-a",
            name: "claude-someone@example.com.json",
            provider: "claude",
            email: "someone@example.com",
            account_type: "max",
            status: "active",
            disabled: false,
            success: 12,
            failed: 0,
          },
          {
            id: "codex-b",
            name: "codex-x-someone@example.com-prolite.json",
            provider: "codex",
            email: "someone@example.com",
            account_type: "prolite",
            status: "active",
            disabled: true,
            success: 3,
            failed: 1,
          },
        ],
      },
    },
  };

  test("normalizes the pool into the shape the surface renders", async () => {
    const { upstreams, error } = await proxyUpstreams("http://127.0.0.1:8317", "mgmt", stub(POOL));
    expect(error).toBeNull();
    expect(upstreams).toHaveLength(2);
    expect(upstreams?.[0]).toMatchObject({
      provider: "claude",
      email: "someone@example.com",
      accountType: "max",
      disabled: false,
      success: 12,
    });
    expect(upstreams?.[1].disabled).toBe(true);
  });

  test("no management key = null, which is NOT an empty pool", async () => {
    // "We never asked" and "we asked and there are none" must stay distinct —
    // the surface says different things about each.
    const { upstreams, error } = await proxyUpstreams("http://127.0.0.1:8317", undefined, stub(POOL));
    expect(upstreams).toBeNull();
    expect(error).toBeNull();
  });

  test("401 says the key was rejected — the common stale-paste case", async () => {
    // The proxy bcrypt-hashes its key at startup, so a key copied after that
    // never works and the user needs to be told exactly this.
    const { upstreams, error } = await proxyUpstreams(
      "http://127.0.0.1:8317",
      "stale",
      stub({ "/v0/management/auth-files": { status: 401, body: {} } }),
    );
    expect(upstreams).toBeNull();
    expect(error).toMatch(/rejected \(401\)/);
  });

  test("404 means the management API is switched off entirely", async () => {
    const { error } = await proxyUpstreams(
      "http://127.0.0.1:8317",
      "any",
      stub({ "/v0/management/auth-files": { status: 404, body: {} } }),
    );
    expect(error).toMatch(/secret-key/);
  });
});

describe("proxyStatus", () => {
  test("an unreachable proxy reports why and asks for nothing else", async () => {
    writeProxyConfig({ enabled: true, url: "http://127.0.0.1:8317" });
    const s = await proxyStatus(unreachable);
    expect(s.reachable).toBe(false);
    expect(s.models).toEqual([]);
    expect(s.error).toMatch(/running/);
  });

  test("reachable: the catalog loads, and the pool is not part of status", async () => {
    setProxyKey("api", "sk-local-secret");
    setProxyKey("management", "");
    const s = await proxyStatus(
      stub({ ...ROOT_OK, "/v1/models": { body: { data: [{ id: "gpt-5.4" }] } } }),
    );
    expect(s.reachable).toBe(true);
    expect(s.models).toEqual(["gpt-5.4"]);
    expect(s.hasApiKey).toBe(true);
    expect(s.hasManagementKey).toBe(false);
    // The pool has no field here at all — reading it costs a lockout attempt,
    // so it is a separate, explicitly-requested call (proxyPool).
    expect("upstreams" in s).toBe(false);
    expect(s.management.blocked).toBe(false);
  });

  test("status never carries a key, only whether one exists", async () => {
    setProxyKey("management", "mgmt-secret");
    const s = await proxyStatus(stub(ROOT_OK));
    expect(JSON.stringify(s)).not.toContain("sk-local-secret");
    expect(JSON.stringify(s)).not.toContain("mgmt-secret");
    expect(s.hasManagementKey).toBe(true);
  });
});

describe("accountEnv routing — the opt-in", () => {
  beforeEach(() => {
    writeProxyConfig({ enabled: true, url: "http://127.0.0.1:8317" });
    setProxyKey("api", "sk-local-secret");
  });

  test("an account WITHOUT proxy stays direct even while the gateway is on", () => {
    const env = accountEnv({ name: "direct", provider: "claude" });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("an account WITH proxy is routed and gets the key", () => {
    const env = accountEnv({ name: "routed", provider: "claude", proxy: {} });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-local-secret");
  });

  test("codex routes through its own env var names", () => {
    const env = accountEnv({ name: "cx", provider: "codex", proxy: {} });
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.OPENAI_API_KEY).toBe("sk-local-secret");
  });

  test("disabling the gateway returns every account to direct — no profile edits", () => {
    writeProxyConfig({ enabled: false });
    const env = accountEnv({ name: "routed", provider: "claude", proxy: {} });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("a missing API key still routes, so the failure is loud", () => {
    // Silently falling back to Anthropic on an account the user believes is
    // proxied would be the worst outcome: right answers, wrong account, no signal.
    setProxyKey("api", "");
    const env = accountEnv({ name: "routed", provider: "claude", proxy: {} });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    setProxyKey("api", "sk-local-secret");
  });

  test("an account's own env still overrides the gateway", () => {
    const env = accountEnv({
      name: "routed",
      provider: "claude",
      proxy: {},
      env: [{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:9999", sensitive: false }],
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999");
  });

  test("ambient pollution loses to both of them", () => {
    process.env.ANTHROPIC_BASE_URL = "http://evil.example";
    const direct = accountEnv({ name: "direct", provider: "claude" });
    const routed = accountEnv({ name: "routed", provider: "claude", proxy: {} });
    expect(direct.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(routed.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    delete process.env.ANTHROPIC_BASE_URL;
  });
});

// ── adopting an upstream as a named account ────────────────────────────────
// The gateway pools its credentials by default. Adopting pins one via a
// `prefix` and gives it a Telar account, so a session can say WHICH login it
// runs on. Two adoption rules had to learn about proxying for that to be
// possible at all — a routed account has no config folder on this machine,
// because its login is in the proxy.
describe("adoption rules for gateway-routed accounts", () => {
  test("a routed Claude account needs no config folder", () => {
    // Un-proxied, this same call is refused — the folder rule is what locates a
    // login on THIS machine, and a routed account's login is not here.
    expect(() => upsertAccount({ name: "pinned-a", provider: "claude" })).toThrow(
      /needs its own config folder/,
    );
    expect(() =>
      upsertAccount({ name: "pinned-a", provider: "claude", proxy: { prefix: "work" } }),
    ).not.toThrow();
    expect(getAccount("pinned-a")?.proxy?.prefix).toBe("work");
  });

  test("a routed account is NOT the auto-detected main account", () => {
    // Both lack a configDir. Without the proxy clause an adopted account would
    // be badged "detected" and refused deletion — backwards for one the user
    // just created.
    expect(isMainAccount(getAccount("personal")!)).toBe(true);
    expect(isMainAccount(getAccount("pinned-a")!)).toBe(false);
    expect(removeAccount("pinned-a")).toBe(true);
  });

  test("routed Codex accounts are exempt from the single-account limit", () => {
    // The limit exists because CODEX_HOME swaps a whole config tree on this
    // machine. A routed account swaps nothing — the gateway holds the login.
    upsertAccount({ name: "cx-gw-1", provider: "codex", proxy: { prefix: "cx1" } });
    expect(() =>
      upsertAccount({ name: "cx-gw-2", provider: "codex", proxy: { prefix: "cx2" } }),
    ).not.toThrow();
    removeAccount("cx-gw-1");
    removeAccount("cx-gw-2");
  });
});

describe("setUpstreamPrefix", () => {
  test("PATCHes the credential's prefix field", async () => {
    let seen: { url: string; method?: string; body?: unknown } | null = null;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await setUpstreamPrefix("http://127.0.0.1:8317", "mgmt", "claude-a.json", "work", spy);
    expect(r.ok).toBe(true);
    expect(seen!.url).toEndWith("/v0/management/auth-files/fields");
    expect(seen!.method).toBe("PATCH");
    expect(seen!.body).toEqual({ name: "claude-a.json", prefix: "work" });
  });

  test("refuses without a management key rather than pretending to succeed", async () => {
    const r = await setUpstreamPrefix("http://127.0.0.1:8317", undefined, "a.json", "work");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/management key is required/i);
  });

  test("a rejected key is reported, not swallowed", async () => {
    const spy = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await setUpstreamPrefix("http://127.0.0.1:8317", "stale", "a.json", "w", spy);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });
});

// ── the management lockout breaker ─────────────────────────────────────────
// CLIProxyAPI's brute-force lockout is hardcoded and self-extending: while
// banned, EVERY request extends the ban, including one carrying the correct
// key. So the only safe behaviour is to stop calling entirely after a failed
// auth and wait for a human. These tests assert we do not touch the network
// once tripped — the usual "retries eventually" expectation is the bug here.
describe("management breaker", () => {
  const counting = (status: number) => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { fn, calls: () => calls };
  };

  test("a 401 trips it, and the SECOND call makes no request at all", async () => {
    const c = counting(401);
    const first = await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(first.upstreams).toBeNull();
    expect(c.calls()).toBe(1);

    const second = await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(second.upstreams).toBeNull();
    expect(c.calls()).toBe(1); // ← no network: retrying would extend the ban
    expect(second.error).toContain("blocked");
  });

  test("a 403 trips it the same way", async () => {
    const c = counting(403);
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(c.calls()).toBe(1);
    expect(managementBreakerState().blocked).toBe(true);
  });

  test("the refusal names the restart, because that is the only fast clear", async () => {
    const c = counting(403);
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    const again = await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(again.error).toContain("brew services restart cliproxyapi");
    expect(managementBreakerState().remedy).toBe("brew services restart cliproxyapi");
  });

  test("pinning an upstream is blocked too — it is the same auth", async () => {
    const c = counting(401);
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    const r = await setUpstreamPrefix("http://127.0.0.1:8317", "k", "a.json", "work", c.fn);
    expect(r.ok).toBe(false);
    expect(c.calls()).toBe(1);
  });

  test("an explicit human action clears it and buys exactly one attempt", async () => {
    const c = counting(401);
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(managementBreakerState().blocked).toBe(true);
    clearManagementBreaker();
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(c.calls()).toBe(2); // one more, then closed again
    await proxyUpstreams("http://127.0.0.1:8317", "k", c.fn);
    expect(c.calls()).toBe(2);
  });

  test("proxyStatus never makes a management call", async () => {
    clearManagementBreaker();
    setProxyKey("management", "some-key");
    let managementCalls = 0;
    const spy = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v0/management")) managementCalls += 1;
      if (u.endsWith("/")) return new Response(JSON.stringify({ message: "CLI Proxy API Server" }));
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
    }) as unknown as typeof fetch;
    const s = await proxyStatus(spy);
    expect(s.reachable).toBe(true);
    // Status used to bundle the pool read, so every settings-page load spent a
    // lockout attempt. It must never do that again.
    expect(managementCalls).toBe(0);
    expect(s.management.blocked).toBe(false);
  });
});

describe("proxyKeyShapeError", () => {
  test("rejects pasted error text (the mistake this form produced)", () => {
    const e = proxyKeyShapeError("management", "HTTP 403: Access denied, remote management is disabled");
    expect(e).toMatch(/spaces or line breaks/);
  });

  test("rejects the config's bcrypt hash, and says why it cannot work", () => {
    const e = proxyKeyShapeError("management", "$2a$10$abcdefghijklmnopqrstuv");
    expect(e).toMatch(/cannot turn it back|bcrypt/i);
  });

  test("catches one key pasted into the other's field", () => {
    const e = proxyKeyShapeError("management", "sk-local-abc", "sk-local-abc");
    expect(e).toMatch(/API key/);
  });

  test("an empty value is a deliberate clear, not an error", () => {
    expect(proxyKeyShapeError("api", "")).toBeNull();
    expect(proxyKeyShapeError("api", "sk-local-legit")).toBeNull();
  });
});
