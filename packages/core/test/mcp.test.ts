import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createProject } = await import("../src/manifest");
const {
  resolveProjectMcpServers,
  refreshProjectMcpAuth,
  setMcpToken,
  getMcpToken,
  clearMcpToken,
  hasMcpToken,
  declaredMcpSecretKeys,
} = await import("../src/mcp");
const { putRecord, getRecord } = await import("../src/mcp-oauth");
type Http = { type: "http"; url: string; headers: Record<string, string> };

// A registered project whose manifest carries stdio + http MCP servers, both
// authed via { secret } refs plus one literal env value.
const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-proj-"));
const project = path.basename(projRoot);
createProject(projRoot, {
  mcpServers: {
    github: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { secret: "gh" }, LOG_LEVEL: "debug" },
    },
    linear: {
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: { secret: "linear", prefix: "Bearer " } },
    },
  },
});

// A project whose manifest carries Telar-owned OAuth http servers alongside a
// non-oauth http server, to exercise the auto-injection path.
const oauthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-oauth-"));
const oproj = path.basename(oauthRoot);
createProject(oauthRoot, {
  mcpServers: {
    // oauth server whose token is mirrored under mcp:<project>:supabase.
    supabase: { transport: "http", url: "https://mcp.supabase.com/mcp", auth: { type: "oauth" } },
    // oauth server that ALSO declares an explicit Authorization header — the
    // user's value must win over the injected Bearer.
    withExplicit: {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer explicit" },
      auth: { type: "oauth" },
    },
    // oauth server with no token stored yet → empty Bearer, no throw.
    noToken: { transport: "http", url: "https://mcp.notoken.com/mcp", auth: { type: "oauth" } },
    // non-oauth http server: never gets an injected Authorization even if a
    // token happens to be mirrored under its name.
    plain: { transport: "http", url: "https://mcp.plain.com/mcp" },
  },
});

// A separate project for the refresh path, isolated so cross-test token writes
// don't interfere with the injection assertions above.
const refreshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-refresh-"));
const rproj = path.basename(refreshRoot);
createProject(refreshRoot, {
  mcpServers: {
    api: { transport: "http", url: "https://api.example.com/mcp", auth: { type: "oauth" } },
    stdiosrv: { transport: "stdio", command: "x" }, // must be skipped by refresh
  },
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
  fs.rmSync(oauthRoot, { recursive: true, force: true });
  fs.rmSync(refreshRoot, { recursive: true, force: true });
});

describe("resolveProjectMcpServers", () => {
  test("materializes a stdio server's env from a { secret } ref", () => {
    setMcpToken(project, "gh", "ghp_secret123");
    const servers = resolveProjectMcpServers(project);
    expect(servers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_secret123", LOG_LEVEL: "debug" },
    });
  });

  test("a literal env value passes through unchanged", () => {
    const env = (resolveProjectMcpServers(project).github as { env: Record<string, string> }).env;
    expect(env.LOG_LEVEL).toBe("debug");
  });

  test("http headers with a { secret, prefix } ref resolve to 'Bearer <token>'", () => {
    setMcpToken(project, "linear", "lin_tok");
    const servers = resolveProjectMcpServers(project);
    expect(servers.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin_tok" },
    });
  });

  test("a missing secret resolves to '' and does not throw", () => {
    // Fresh project so 'gh' has never been set for it.
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-miss-"));
    const p2 = path.basename(root2);
    createProject(root2, {
      mcpServers: {
        github: { transport: "stdio", command: "npx", env: { GITHUB_TOKEN: { secret: "gh" } } },
      },
    });
    const servers = resolveProjectMcpServers(p2);
    expect((servers.github as { env: Record<string, string> }).env.GITHUB_TOKEN).toBe("");
    // prefix still applies when the token is missing
    fs.rmSync(root2, { recursive: true, force: true });
  });

  test("a manifest with no mcpServers → resolver returns {}", () => {
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-empty-"));
    const p3 = path.basename(root3);
    // A telar.yaml with no mcpServers field must still parse (default {}) and
    // resolve to an empty, always-spreadable object.
    createProject(root3, {});
    expect(resolveProjectMcpServers(p3)).toEqual({});
    fs.rmSync(root3, { recursive: true, force: true });
  });
});

describe("resolveProjectMcpServers — Telar-owned OAuth injection", () => {
  test("injects Authorization: Bearer <mirrored token> for an oauth http server", () => {
    setMcpToken(oproj, "supabase", "mirrored_tok");
    const supabase = resolveProjectMcpServers(oproj).supabase as Http;
    expect(supabase.headers.Authorization).toBe("Bearer mirrored_tok");
  });

  test("does not overwrite an Authorization the user already declared", () => {
    // A mirrored token exists, but the explicit header must win.
    setMcpToken(oproj, "withExplicit", "should_be_ignored");
    const srv = resolveProjectMcpServers(oproj).withExplicit as Http;
    expect(srv.headers.Authorization).toBe("Bearer explicit");
  });

  test("does not inject for a non-oauth http server (even if a token is mirrored)", () => {
    setMcpToken(oproj, "plain", "unused");
    const plain = resolveProjectMcpServers(oproj).plain as Http;
    expect(plain.headers.Authorization).toBeUndefined();
    expect(plain.headers).toEqual({});
  });

  test("a missing oauth token → empty Bearer, does not throw", () => {
    const noToken = resolveProjectMcpServers(oproj).noToken as Http;
    expect(noToken.headers.Authorization).toBe("Bearer ");
  });
});

describe("refreshProjectMcpAuth", () => {
  // Build a Telar-owned OAuth record for refreshRoot's `api` server whose token
  // is near expiry (within the 60s skew) so needsRefresh() fires.
  const nearExpiryRecord = () => ({
    project: rproj,
    server: "api",
    resource: "https://api.example.com/mcp",
    as: {
      issuer: "https://as.example.com",
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
    },
    client: { strategy: "manual" as const, id: "client_abc" },
    tokens: { accessToken: "old_tok", refreshToken: "refresh_1", expiresAt: Date.now() + 1_000 },
  });

  const withMockFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = orig;
    }
  };

  test("no-op (and never fetches) when the project has no oauth servers", async () => {
    let called = false;
    await withMockFetch((async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch, async () => {
      // `project` has only stdio + a non-oauth http server.
      await refreshProjectMcpAuth(project);
    });
    expect(called).toBe(false);
  });

  test("refreshes a near-expiry record and re-mirrors the new access token", async () => {
    putRecord(nearExpiryRecord());
    await withMockFetch((async () =>
      new Response(JSON.stringify({ access_token: "new_tok", refresh_token: "refresh_2", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch, async () => {
      await refreshProjectMcpAuth(rproj);
    });
    // Record + mirror both updated; resolver now injects the fresh token.
    expect(getRecord(rproj, "api")?.tokens.accessToken).toBe("new_tok");
    expect(getMcpToken(rproj, "api")).toBe("new_tok");
    const api = resolveProjectMcpServers(rproj).api as Http;
    expect(api.headers.Authorization).toBe("Bearer new_tok");
  });

  test("swallows a refresh failure — never throws, leaves the old token", async () => {
    putRecord(nearExpiryRecord()); // resets to old_tok / near expiry
    setMcpToken(rproj, "api", "old_tok");
    await withMockFetch((async () => {
      throw new Error("network down");
    }) as typeof fetch, async () => {
      // Must resolve without throwing despite the failing token endpoint.
      await refreshProjectMcpAuth(rproj);
    });
    expect(getMcpToken(rproj, "api")).toBe("old_tok");
  });

  test("does not refresh a record that is not near expiry", async () => {
    let called = false;
    putRecord({ ...nearExpiryRecord(), tokens: { accessToken: "far_tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } });
    await withMockFetch((async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch, async () => {
      await refreshProjectMcpAuth(rproj);
    });
    expect(called).toBe(false);
  });
});

describe("declaredMcpSecretKeys", () => {
  test("collects distinct { secret } keys across env + headers, sorted", () => {
    expect(declaredMcpSecretKeys(project)).toEqual(["gh", "linear"]);
  });

  test("a project with no mcpServers → []", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-none-"));
    const p = path.basename(root);
    createProject(root, {});
    expect(declaredMcpSecretKeys(p)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("literal (non-ref) values contribute no keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-lit-"));
    const p = path.basename(root);
    createProject(root, {
      mcpServers: {
        srv: { transport: "stdio", command: "x", env: { LOG_LEVEL: "debug" } },
      },
    });
    expect(declaredMcpSecretKeys(p)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("clearMcpToken / hasMcpToken", () => {
  test("set → has → clear round-trip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-clear-"));
    const p = path.basename(root);
    createProject(root, {});
    expect(hasMcpToken(p, "tok")).toBe(false);
    setMcpToken(p, "tok", "s3cr3t");
    expect(hasMcpToken(p, "tok")).toBe(true);
    expect(clearMcpToken(p, "tok")).toBe(true);
    expect(hasMcpToken(p, "tok")).toBe(false);
    // Clearing an absent token reports false.
    expect(clearMcpToken(p, "tok")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
