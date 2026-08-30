#!/usr/bin/env bun
/**
 * MCP stdio server exposing the lease scheduler to agent sessions.
 * The moat rule applies: there are environment and worktree tools here,
 * and there will never be an `accept` tool.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runConformance } from "./conformance.ts";
import { createWorktree, listWorktrees, projectContext } from "./context.ts";
import { init } from "./init.ts";
import { acquire, downStale, reclaimStale, release, renew } from "./lease.ts";
import { snapshotState } from "./state.ts";
import { runTier } from "./tiers.ts";

const cwdProp = {
  cwd: {
    type: "string",
    description: "Directory inside the project (any worktree). Defaults to the server's cwd.",
  },
} as const;

const TOOLS = [
  {
    name: "env_lease",
    description:
      "Acquire a leased environment for the current worktree. Returns the lease (slot, port base, TELAR_* values) when granted, or a queue position when the pool is full. Re-calling from a worktree that already holds a lease renews and returns it (the repair exception).",
    inputSchema: { type: "object", properties: { ...cwdProp } },
  },
  {
    name: "env_release",
    description:
      "Release a lease by id. The environment is kept warm for fast reacquisition when nobody is queued; pass down=true to force teardown.",
    inputSchema: {
      type: "object",
      properties: { leaseId: { type: "string" }, down: { type: "boolean" } },
      required: ["leaseId"],
    },
  },
  {
    name: "env_renew",
    description: "Extend a lease's TTL. Call periodically during long verify/repair cycles.",
    inputSchema: {
      type: "object",
      properties: { leaseId: { type: "string" } },
      required: ["leaseId"],
    },
  },
  {
    name: "env_status",
    description: "Machine-wide pool state: slots, reserved port ranges, active leases, queue. Reclaims stale leases first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_context",
    description:
      "Everything Telar knows about this project: identity, environment contract, worktrees with slots, active leases, queue. Call this at the start of a session.",
    inputSchema: { type: "object", properties: { ...cwdProp } },
  },
  {
    name: "env_tier",
    description:
      "Run a verification tier. `unit` runs unleased (cheap, always parallel-safe); other tiers auto-lease an environment, run, and release it (kept warm). Pass keepLease=true to hold the lease afterwards for browser verification or repair — you then own env_release.",
    inputSchema: {
      type: "object",
      properties: { tier: { type: "string" }, keepLease: { type: "boolean" }, ...cwdProp },
      required: ["tier"],
    },
  },
  {
    name: "env_init",
    description:
      "Scaffold a sidecar environment contract for an un-onboarded project. Dry-run by default (returns the template); write=true creates the sidecar file. Follow packages/env/ONBOARDING.md, then prove with env_conform.",
    inputSchema: {
      type: "object",
      properties: { write: { type: "boolean" }, ...cwdProp },
    },
  },
  {
    name: "env_conform",
    description: "Run the contract-v1 conformance sequence (up → ready → idempotent up → reset → down → down) on a scratch slot. Use after writing or changing a project's env contract.",
    inputSchema: { type: "object", properties: { ...cwdProp } },
  },
  {
    name: "worktree_list",
    description: "List the project's git worktrees with their assigned slots.",
    inputSchema: { type: "object", properties: { ...cwdProp } },
  },
  {
    name: "worktree_create",
    description: "Create a new git worktree on a new branch. A slot is assigned on first lease.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        path: { type: "string", description: "Optional target path; defaults to <primary>-wt-<branch>." },
        ...cwdProp,
      },
      required: ["branch"],
    },
  },
];

const server = new Server(
  { name: "telar-env", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const result = await (async () => {
    switch (request.params.name) {
      case "env_lease":
        return acquire({ cwd });
      case "env_release":
        return release(String(args.leaseId ?? ""), { down: Boolean(args.down) });
      case "env_renew":
        return renew(String(args.leaseId ?? ""));
      case "env_status": {
        await downStale(reclaimStale());
        return snapshotState();
      }
      case "project_context":
        return projectContext(cwd);
      case "env_tier":
        return runTier({ cwd, tier: String(args.tier ?? ""), keepLease: Boolean(args.keepLease) });
      case "env_init":
        return init(cwd, { write: Boolean(args.write) });
      case "env_conform":
        return runConformance(cwd);
      case "worktree_list":
        return listWorktrees(cwd);
      case "worktree_create":
        return createWorktree(cwd, String(args.branch ?? ""), typeof args.path === "string" ? args.path : undefined);
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  })();
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
