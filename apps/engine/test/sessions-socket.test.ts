/**
 * The sessions socket — the `sessions` toolkit as an outward MCP server,
 * driven over real HTTP because the transport IS the feature.
 *
 * The properties under test are the same four the notebook's socket promises,
 * and they are asserted the same way for the same reason:
 *   · the SAME wall a session gets — tool-list parity is asserted against
 *     `sessionsTools` itself, not a copied list;
 *   · the wall's absences ride along — nothing here can accept, merge, archive
 *     or delete, and the socket's secret opens NOTHING else on the engine;
 *   · a dedicated secret, minted once, persisted, and DISTINCT from the notes
 *     socket's as well as from the management token;
 *   · the store's guards ride along too — an argument the wall's schema
 *     refuses never reaches a handler, whichever door it came through.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { collectSessionsWallTools } from "../src/sessions-tools/socket";
import type { SessionsCapability } from "../src/sessions-tools/tools";
import { stubModels } from "./stub-models";
import { worktreeReady } from "./worktree-ready";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/** A throwaway repository with one commit — the house idiom, so a `worktree`
 *  create over the socket cuts a real checkout rather than being stubbed. */
function repo(): string {
  const root = tmp("telar-sessions-socket-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

async function engine(options: { engineRoot?: string } = {}): Promise<EngineDaemon> {
  const directory = options.engineRoot ?? tmp("telar-sessions-socket-");
  const daemon = await startEngine({ models: stubModels, engineRoot: directory });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const socketUrl = (daemon: EngineDaemon) => `http://127.0.0.1:${daemon.discovery.port}/v2/sessions/mcp`;

async function rpc(daemon: EngineDaemon, secret: string, message: unknown): Promise<Response> {
  return fetch(socketUrl(daemon), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
}

async function callTool(daemon: EngineDaemon, secret: string, name: string, args: Record<string, unknown>) {
  const answered = await rpc(daemon, secret, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  const { result } = (await answered.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

/** The wall's own tool names, collected through the same seam the socket uses.
 *  The capability is never invoked for a listing, so an empty stub is honest. */
const wallNames = collectSessionsWallTools({} as SessionsCapability).map((tool) => tool.name);

describe("the connect card and the secret", () => {
  test("mcp-info answers behind the bearer with a secret that is neither the management token nor the notebook's, persisted across restarts", async () => {
    const directory = tmp("telar-sessions-socket-persist-");
    const first = await engine({ engineRoot: directory });
    const client = new EngineClient(first.discovery);
    const { mcp } = await client.sessionsMcpInfo();

    expect(mcp.url).toBe(socketUrl(first));
    expect(mcp.secret).not.toBe(first.discovery.token);
    expect(mcp.secret.length).toBeGreaterThanOrEqual(32);
    // TWO DOORS, TWO KEYS. Revoking a chat client's reach into sessions must
    // not be the same act as revoking its reach into the notebook.
    expect(mcp.secret).not.toBe((await client.notesMcpInfo()).mcp.secret);
    expect(mcp.addCommand).toBe(
      `claude mcp add --transport http telar-sessions ${mcp.url} --header "Authorization: Bearer ${mcp.secret}"`,
    );

    // Minted ONCE: a second read and a restarted daemon hand out the same one.
    expect((await client.sessionsMcpInfo()).mcp.secret).toBe(mcp.secret);
    await first.close();
    const second = await engine({ engineRoot: directory });
    expect((await new EngineClient(second.discovery).sessionsMcpInfo()).mcp.secret).toBe(mcp.secret);
    // 0600 — it is a credential sitting beside engine.json.
    expect(fs.statSync(path.join(directory, "sessions-mcp-secret.json")).mode & 0o777).toBe(0o600);
  });

  test("the credentials open only their own doors", async () => {
    const daemon = await engine();
    const client = new EngineClient(daemon.discovery);
    const { mcp } = await client.sessionsMcpInfo();
    const notes = (await client.notesMcpInfo()).mcp;
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    expect((await rpc(daemon, daemon.discovery.token, ping)).status).toBe(401);
    expect((await rpc(daemon, "not-a-secret", ping)).status).toBe(401);
    // …AND NOT THE NOTEBOOK'S EITHER. Two sockets on one daemon that accepted
    // each other's keys would be one socket wearing two names.
    expect((await rpc(daemon, notes.secret, ping)).status).toBe(401);
    expect((await rpc(daemon, mcp.secret, ping)).status).toBe(200);

    // The socket secret grants NOTHING on the engine API — above all not the
    // archive and delete verbs, which are how a client would otherwise free
    // its own create budget.
    const base = `http://127.0.0.1:${daemon.discovery.port}`;
    const asSocket = { authorization: `Bearer ${mcp.secret}`, "content-type": "application/json" };
    expect((await fetch(`${base}/v2/health`, { headers: asSocket })).status).toBe(401);
    expect((await fetch(`${base}/v2/sessions/live`, { headers: asSocket })).status).toBe(401);
    expect((await fetch(`${base}/v2/sessions/session_x/archive`, { method: "POST", headers: asSocket, body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/v2/sessions/session_x`, { method: "DELETE", headers: asSocket })).status).toBe(401);
  });
});

describe("the protocol surface", () => {
  test("initialize answers tools-only capabilities; a notification is a bare 202; GET has no stream to offer", async () => {
    const daemon = await engine();
    const { mcp } = await new EngineClient(daemon.discovery).sessionsMcpInfo();

    const initialized = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const answer = (await initialized.json()) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    expect(answer.result.protocolVersion).toBe("2025-06-18");
    expect(answer.result.capabilities).toEqual({ tools: {} });
    // Its OWN name, so a client showing two Telar servers can tell them apart.
    expect(answer.result.serverInfo.name).toBe("telar-sessions");

    const notified = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);

    expect((await fetch(socketUrl(daemon), { headers: { authorization: `Bearer ${mcp.secret}` } })).status).toBe(405);
    expect((await fetch(socketUrl(daemon), { method: "DELETE", headers: { authorization: `Bearer ${mcp.secret}` } })).status).toBe(200);

    const unknown = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  test("tools/list IS the wall — the exact names sessionsTools registers, and nothing that lands work", async () => {
    const daemon = await engine();
    const { mcp } = await new EngineClient(daemon.discovery).sessionsMcpInfo();
    const listed = await rpc(daemon, mcp.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { result } = (await listed.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> } };

    // PARITY WITH THE WALL, structurally: both lists come from `sessionsTools`,
    // so a tool added to the toolkit appears here in the same change or this
    // fails.
    expect(result.tools.map((tool) => tool.name)).toEqual(wallNames);
    expect(result.tools.length).toBe(13);
    for (const tool of result.tools) {
      expect(tool.name).not.toMatch(/accept|approve|merge|land|archive|delete|promote|finish|complete/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
    // The prose a model reads rides along whole rather than being re-authored
    // for the socket — including the sentence the wall can only say.
    expect(result.tools.find((tool) => tool.name === "sessions_create")!.description).toContain(
      "NEVER use this to get around something you were refused",
    );
  });

  test("one tools/call round-trip: create a session from outside, and the engine holds it as an agent's", async () => {
    const daemon = await engine();
    const client = new EngineClient(daemon.discovery);
    const { mcp } = await client.sessionsMcpInfo();
    const { project } = await client.registerProject({ name: "aurora", root: repo() });

    const created = await callTool(daemon, mcp.secret, "sessions_create", {
      projectId: project.id,
      title: "cut from a chat client",
      envMode: "worktree",
    });
    expect(created.isError).toBe(false);
    const made = JSON.parse(created.text) as { id: string; branch: string };
    // Branch slugs come from the WORK, not the machinery (d3e615b):
    // `telar/<title-slug>-<id6>` when the session has a usable title.
    expect(made.branch).toBe(`telar/cut-from-a-chat-client-${made.id.replace(/^session_/, "").slice(0, 6)}`);

    // The same engine every other surface reads, and the socket is an AGENT'S
    // door, so the session is stamped as one.
    const { session } = await client.session(made.id);
    expect(session.title).toBe("cut from a chat client");
    expect(session.origin).toBe("session");
    // The cut runs behind the tool's answer now (#496) — the row is complete,
    // the directory arrives a moment later.
    await worktreeReady(daemon.store, made.id);
    expect(fs.existsSync(path.join(session.workspace.path, "README.md"))).toBe(true);

    // A tool the wall does not have is a -32602, not a silent success.
    const missing = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "sessions_archive", arguments: { sessionId: made.id } },
    });
    expect(((await missing.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  test("a chat client has no session to wake: the subscription tools refuse, in words, and the rest still work", async () => {
    // The socket's capability carries no `self` — a chat client is not a
    // session — so subscribing there would be subscribing nobody. The wall
    // says so rather than silently succeeding; the other tools are unaffected.
    const daemon = await engine();
    const client = new EngineClient(daemon.discovery);
    const { mcp } = await client.sessionsMcpInfo();
    const { project } = await client.registerProject({ name: "aurora", root: repo() });
    const { session } = await client.createSession({ projectId: project.id, title: "a target" });

    for (const name of ["sessions_subscribe", "sessions_unsubscribe", "sessions_subscriptions"]) {
      const refused = await callTool(daemon, mcp.secret, name, { sessionId: session.id, subscriptionId: "sub_x" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("no session to wake");
    }
    const requests = await callTool(daemon, mcp.secret, "sessions_requests", { sessionId: session.id });
    expect(requests.isError).toBe(false);
    expect(requests.text).toContain("not waiting on anything");
  });

  test("an argument the wall's schema refuses never reaches a handler", async () => {
    const daemon = await engine();
    const { mcp } = await new EngineClient(daemon.discovery).sessionsMcpInfo();
    // `envMode` is required and closed — a socket that skipped validation would
    // hand the handler an argument no session could ever send.
    const bad = await rpc(daemon, mcp.secret, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "sessions_create", arguments: { projectId: "p", envMode: "container" } },
    });
    expect(((await bad.json()) as { error: { code: number; message: string } }).error.code).toBe(-32602);
  });
});
