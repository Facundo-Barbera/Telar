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
  setMcpToken,
  clearMcpToken,
  hasMcpToken,
  declaredMcpSecretKeys,
} = await import("../src/mcp");

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

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
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
