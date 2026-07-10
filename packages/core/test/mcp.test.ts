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
const { resolveProjectMcpServers, setMcpToken } = await import("../src/mcp");

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
