/**
 * The socket — the Spool as an outward MCP server (`docs/spool-loops.md`
 * §10.3), driven over real HTTP because the transport IS the feature.
 *
 * The properties under test are the doc's promises:
 *   · the SAME wall a session gets — tool-list parity is asserted against
 *     `spoolTools` itself, not a copied list;
 *   · the wall's absences ride along — nothing on the socket can close,
 *     reopen, delete or accept, and the socket's secret opens NOTHING else;
 *   · a dedicated secret, minted once and persisted — never the management
 *     token, in either direction.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { collectWallTools } from "../src/spool/socket";
import type { SpoolCapability } from "../src/spool/tools";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

async function spool(engineRoot?: string): Promise<EngineDaemon> {
  const directory = engineRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-socket-"));
  if (!engineRoot) roots.push(directory);
  const daemon = await startEngine({ models: stubModels, engineRoot: directory });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const socketUrl = (daemon: EngineDaemon) => `http://127.0.0.1:${daemon.discovery.port}/v2/spool/mcp`;

async function rpc(daemon: EngineDaemon, secret: string, message: unknown): Promise<Response> {
  return fetch(socketUrl(daemon), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
}

/** The wall's own tool names, collected through the same seam the socket uses.
 *  The capability is never invoked for a listing, so an empty stub is honest. */
const wallNames = collectWallTools({} as SpoolCapability).map((tool) => tool.name);

describe("the connect card and the secret", () => {
  test("mcp-info answers behind the bearer with a dedicated secret that is NOT the management token, persisted across restarts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-socket-persist-"));
    roots.push(directory);
    const first = await spool(directory);
    const client = new EngineClient(first.discovery);
    const { mcp } = await client.spoolMcpInfo();

    expect(mcp.url).toBe(socketUrl(first));
    expect(mcp.secret).not.toBe(first.discovery.token);
    expect(mcp.secret.length).toBeGreaterThanOrEqual(32);
    // The composed line carries the url and the header — the card and the
    // socket cannot disagree because both come from one function.
    expect(mcp.addCommand).toBe(`claude mcp add --transport http spool ${mcp.url} --header "Authorization: Bearer ${mcp.secret}"`);

    // Minted ONCE: a second read and a restarted daemon hand out the same one.
    expect((await client.spoolMcpInfo()).mcp.secret).toBe(mcp.secret);
    await first.close();
    const second = await spool(directory);
    expect((await new EngineClient(second.discovery).spoolMcpInfo()).mcp.secret).toBe(mcp.secret);
  });

  test("the two credentials open only their own doors: engine token refused on the socket, socket secret refused everywhere else", async () => {
    const daemon = await spool();
    const { mcp } = await new EngineClient(daemon.discovery).spoolMcpInfo();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    // The management token is NOT a socket credential…
    expect((await rpc(daemon, daemon.discovery.token, ping)).status).toBe(401);
    expect((await rpc(daemon, "not-a-secret", ping)).status).toBe(401);
    expect((await rpc(daemon, mcp.secret, ping)).status).toBe(200);

    // …and the socket secret grants NOTHING on the engine API — above all not
    // the human-only close verbs the wall exists to keep from agents.
    const base = `http://127.0.0.1:${daemon.discovery.port}`;
    const asSocket = { authorization: `Bearer ${mcp.secret}`, "content-type": "application/json" };
    expect((await fetch(`${base}/v2/health`, { headers: asSocket })).status).toBe(401);
    const closeMany = await fetch(`${base}/v2/spool/items/close-many`, {
      method: "POST",
      headers: asSocket,
      body: JSON.stringify({ ids: ["i-1"] }),
    });
    expect(closeMany.status).toBe(401);
  });
});

describe("the protocol surface", () => {
  test("initialize answers tools-only capabilities; a notification is a bare 202; GET has no stream to offer", async () => {
    const daemon = await spool();
    const { mcp } = await new EngineClient(daemon.discovery).spoolMcpInfo();

    const initialized = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const answer = (await initialized.json()) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    expect(answer.result.protocolVersion).toBe("2025-06-18");
    expect(answer.result.capabilities).toEqual({ tools: {} });
    expect(answer.result.serverInfo.name).toBe("telar-spool");

    const notified = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);

    expect((await fetch(socketUrl(daemon), { headers: { authorization: `Bearer ${mcp.secret}` } })).status).toBe(405);
    expect((await fetch(socketUrl(daemon), { method: "DELETE", headers: { authorization: `Bearer ${mcp.secret}` } })).status).toBe(200);

    const unknown = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  test("tools/list IS the wall — the exact names spoolTools registers, no close, no reopen, no delete, no accept", async () => {
    const daemon = await spool();
    const { mcp } = await new EngineClient(daemon.discovery).spoolMcpInfo();
    const listed = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { result } = (await listed.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> } };

    // PARITY WITH THE WALL, structurally: both lists come from `spoolTools`,
    // so a tool added to sessions appears here in the same change or this
    // fails.
    expect(result.tools.map((tool) => tool.name)).toEqual(wallNames);
    // The absences are the contract, §9 above all: no verb here can spell
    // doneness or deletion.
    for (const tool of result.tools) {
      expect(tool.name).not.toMatch(/close|reopen|delete|remove|accept|promote/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("one tools/call round-trip: file an item from outside, and the store holds it as a session's filing", async () => {
    const daemon = await spool();
    const client = new EngineClient(daemon.discovery);
    const { mcp } = await client.spoolMcpInfo();

    const called = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spool_create_item", arguments: { title: "filed from Claude Desktop" } },
    });
    const { result } = (await called.json()) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(result.isError).toBeUndefined();
    const filed = JSON.parse(result.content[0]!.text) as { id: string; note: string };
    expect(filed.note).toContain("Filed, not started");

    // The same store every other surface reads — and the socket is an AGENT'S
    // door, so the filing is stamped as one.
    const snapshot = await client.spool();
    const item = snapshot.rows.find((row) => row.item.id === filed.id)!.item;
    expect(item.title).toBe("filed from Claude Desktop");
    expect(item.provenance).toBe("session");
    expect(snapshot.agentsAdded).toBe(1);

    // A tool the wall does not have is a -32602, not a silent success.
    const missing = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "spool_close_item", arguments: { itemId: filed.id } },
    });
    expect(((await missing.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });
});
