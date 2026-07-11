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

// A project exercising record-gated injection: OAuth is DETECTED (a stored
// Connect record), never declared. Injection keys on the record, not the
// optional `auth` block.
const oauthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-oauth-"));
const oproj = path.basename(oauthRoot);
createProject(oauthRoot, {
  mcpServers: {
    // Recorded server with NO auth block — injection fires purely on the record.
    supabase: { transport: "http", url: "https://mcp.supabase.com/mcp" },
    // Has an `auth` block but NO Connect record → must NOT inject.
    declaredNoRecord: { transport: "http", url: "https://mcp.declared.com/mcp", auth: { type: "oauth" } },
    // Recorded server that ALSO declares an explicit Authorization header — the
    // user's value must win over the injected Bearer.
    withExplicit: {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer explicit" },
    },
    // Plain http server, no record: never gets an injected Authorization even if
    // a token happens to be mirrored under its name.
    plain: { transport: "http", url: "https://mcp.plain.com/mcp" },
  },
});

// A minimal Connect record (only the fields injection/refresh read), so the
// resolver's record-gated Bearer injection fires for a project's server.
const recordFor = (proj: string, server: string) => ({
  project: proj,
  server,
  resource: `https://${server}.example.com/mcp`,
  as: {
    issuer: "https://as.example.com",
    authorizationEndpoint: "https://as.example.com/authorize",
    tokenEndpoint: "https://as.example.com/token",
  },
  client: { strategy: "manual" as const, id: "client_abc" },
  tokens: { accessToken: "at" },
});

// A separate project for the refresh path, isolated so cross-test token writes
// don't interfere with the injection assertions above.
const refreshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-refresh-"));
const rproj = path.basename(refreshRoot);
createProject(refreshRoot, {
  mcpServers: {
    // No auth block: refresh is keyed on the stored record, not the block.
    api: { transport: "http", url: "https://api.example.com/mcp" },
    stdiosrv: { transport: "stdio", command: "x" }, // never gets a record → skipped
  },
});

// A project exercising the `enabled` kill-switch (schemas.ts: only enabled:false
// disables; absent/true stay live).
const enabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-enabled-"));
const eproj = path.basename(enabledRoot);
createProject(enabledRoot, {
  mcpServers: {
    on: { transport: "stdio", command: "x", enabled: true },
    off: { transport: "stdio", command: "y", enabled: false },
    implicit: { transport: "stdio", command: "z" }, // enabled absent → live
    // Disabled http server that ALSO has a Connect record — must still be
    // dropped entirely (never materialized, no injected Bearer).
    offRecorded: { transport: "http", url: "https://mcp.off.com/mcp", enabled: false },
  },
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
  fs.rmSync(oauthRoot, { recursive: true, force: true });
  fs.rmSync(refreshRoot, { recursive: true, force: true });
  fs.rmSync(enabledRoot, { recursive: true, force: true });
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

describe("resolveProjectMcpServers — record-gated OAuth injection", () => {
  test("injects Bearer <mirrored token> for a recorded server with NO auth block", () => {
    putRecord(recordFor(oproj, "supabase"));
    setMcpToken(oproj, "supabase", "mirrored_tok");
    const supabase = resolveProjectMcpServers(oproj).supabase as Http;
    expect(supabase.headers.Authorization).toBe("Bearer mirrored_tok");
  });

  test("does NOT inject for an auth-block server that has no Connect record", () => {
    // A token happens to be mirrored, but with no record injection must not fire.
    setMcpToken(oproj, "declaredNoRecord", "should_be_ignored");
    const srv = resolveProjectMcpServers(oproj).declaredNoRecord as Http;
    expect(srv.headers.Authorization).toBeUndefined();
    expect(srv.headers).toEqual({});
  });

  test("never overwrites an Authorization the user already declared", () => {
    // Recorded AND explicitly headered — the user's value must win.
    putRecord(recordFor(oproj, "withExplicit"));
    setMcpToken(oproj, "withExplicit", "should_be_ignored");
    const srv = resolveProjectMcpServers(oproj).withExplicit as Http;
    expect(srv.headers.Authorization).toBe("Bearer explicit");
  });

  test("does not inject for a plain http server with no record", () => {
    setMcpToken(oproj, "plain", "unused");
    const plain = resolveProjectMcpServers(oproj).plain as Http;
    expect(plain.headers.Authorization).toBeUndefined();
    expect(plain.headers).toEqual({});
  });
});

describe("resolveProjectMcpServers — enabled kill-switch", () => {
  test("drops a server with enabled:false", () => {
    expect(resolveProjectMcpServers(eproj).off).toBeUndefined();
  });

  test("keeps enabled:true and an absent enabled (both live)", () => {
    const servers = resolveProjectMcpServers(eproj);
    expect(servers.on).toBeDefined();
    expect(servers.implicit).toBeDefined();
  });

  test("skips a disabled server even when it has a Connect record", () => {
    putRecord(recordFor(eproj, "offRecorded"));
    setMcpToken(eproj, "offRecorded", "mirrored_tok");
    expect(resolveProjectMcpServers(eproj).offRecorded).toBeUndefined();
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

  test("no-op (and never fetches) when no server has a Connect record", async () => {
    let called = false;
    await withMockFetch((async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch, async () => {
      // `project` (stdio + linear http) has no OAuth records at all.
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
