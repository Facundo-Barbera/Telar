import { afterAll, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the Claude Agent SDK so verify() runs the REAL agent() event loop against
// an empty synthetic stream — no live model call, no browser. We only capture
// the mcpServers the SDK query is configured with, to prove the project's
// servers are made available to the verifier the same way the builder gets them.
let capturedMcpServers: Record<string, unknown> = {};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool: () => ({}),
  createSdkMcpServer: (cfg: unknown) => cfg,
  query: (args: { options: { mcpServers: Record<string, unknown> } }) => {
    capturedMcpServers = args.options.mcpServers;
    return (async function* () {})();
  },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-verifier-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

// Import after the SDK mock is registered so engine (and verify) bind the stub.
const { createProject } = await import("../src/manifest");
const { verify } = await import("../src/verifier");

const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-verifier-proj-"));
const projectName = path.basename(projRoot);
createProject(projRoot, {
  mcpServers: { db: { transport: "stdio", command: "x", args: ["--read-only"] } },
});

const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-verifier-ev-"));
const feature = { name: "checkout", acceptanceCriteria: ["it works"] };

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
  fs.rmSync(evidenceDir, { recursive: true, force: true });
});

describe("verify — project MCP access", () => {
  test("includes the project's MCP servers alongside playwright when project is set", async () => {
    capturedMcpServers = {};
    await verify(feature, { url: "http://localhost:3000", evidenceDir, project: projectName });
    expect(capturedMcpServers.playwright).toBeDefined();
    expect(capturedMcpServers.db).toBeDefined();
  });

  test("only playwright (no project servers) when project is absent — back-compat", async () => {
    capturedMcpServers = {};
    await verify(feature, { url: "http://localhost:3000", evidenceDir });
    expect(capturedMcpServers.playwright).toBeDefined();
    expect(capturedMcpServers.db).toBeUndefined();
  });
});
