import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { collectNotesWallTools } from "./socket";
import { notesTools, type NotesCapability } from "./tools";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

function repo(): string {
  const root = tmp("telar-notes-socket-repo-");
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
  const daemon = await startEngine({ models: stubModels, engineRoot: options.engineRoot ?? tmp("telar-notes-socket-") });
  daemons.push(daemon);
  return daemon;
}

const socketUrl = (daemon: EngineDaemon) => `http://127.0.0.1:${daemon.discovery.port}/v2/notes/mcp`;

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

async function connected() {
  const daemon = await engine();
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  const { mcp } = await client.notesMcpInfo();
  return { daemon, client, projectId: project.id, secret: mcp.secret, mcp };
}

const wallNames = collectNotesWallTools({} as NotesCapability).map((tool) => tool.name);

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the connect card and the secret", () => {
  test("mcp-info answers behind the bearer with a secret that is neither the token nor the other sockets', persisted across restarts", async () => {
    const directory = tmp("telar-notes-socket-persist-");
    const first = await engine({ engineRoot: directory });
    const client = new EngineClient(first.discovery);
    const { mcp } = await client.notesMcpInfo();

    expect(mcp.url).toBe(socketUrl(first));
    expect(mcp.secret).not.toBe(first.discovery.token);
    expect(mcp.secret.length).toBeGreaterThanOrEqual(32);
    expect(mcp.secret).not.toBe((await client.sessionsMcpInfo()).mcp.secret);
    expect(mcp.secret).not.toBe((await client.sessionsMcpInfo()).mcp.secret);
    expect(mcp.addCommand).toBe(`claude mcp add --transport http telar-notes ${mcp.url} --header "Authorization: Bearer ${mcp.secret}"`);

    expect((await client.notesMcpInfo()).mcp.secret).toBe(mcp.secret);
    await first.close();
    const second = await engine({ engineRoot: directory });
    expect((await new EngineClient(second.discovery).notesMcpInfo()).mcp.secret).toBe(mcp.secret);
    expect(fs.statSync(path.join(directory, "notes-mcp-secret.json")).mode & 0o777).toBe(0o600);
  });

  test("the credential opens only its own door", async () => {
    const { daemon, client, secret } = await connected();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    expect((await rpc(daemon, daemon.discovery.token, ping)).status).toBe(401);
    expect((await rpc(daemon, "not-a-secret", ping)).status).toBe(401);
    expect((await rpc(daemon, (await client.sessionsMcpInfo()).mcp.secret, ping)).status).toBe(401);
    expect((await rpc(daemon, secret, ping)).status).toBe(200);

    const base = `http://127.0.0.1:${daemon.discovery.port}`;
    const asSocket = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
    expect((await fetch(`${base}/v2/health`, { headers: asSocket })).status).toBe(401);
    expect((await fetch(`${base}/v2/projects`, { headers: asSocket })).status).toBe(401);
    expect((await fetch(`${base}/v2/sessions/live`, { headers: asSocket })).status).toBe(401);
  });
});

describe("the wall rides along whole", () => {
  test("tools/list is the toolkit itself — parity is structural, not maintained by hand", async () => {
    const { daemon, secret } = await connected();
    const answered = await rpc(daemon, secret, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const { result } = (await answered.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };

    const inSession = (notesTools(((name: string) => ({ name })) as never, {} as NotesCapability) as Array<{ name: string }>).map((t) => t.name);
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...wallNames].sort());
    expect([...wallNames].sort()).toEqual([...inSession].sort());
    expect(wallNames.sort()).toEqual(["notes_delete", "notes_list", "notes_write"]);

    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test("a client with no session is asked for the project by name", async () => {
    const { daemon, secret } = await connected();
    const refused = await callTool(daemon, secret, "notes_list", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/projects: true/);
  });
});

describe("the store's rules ride along too", () => {
  test("write, list and read go through the same store the routes use", async () => {
    const { daemon, client, projectId, secret } = await connected();

    const written = await callTool(daemon, secret, "notes_write", { projectId, title: "Deploy", body: "bun run ship" });
    expect(written.isError).toBe(false);
    const note = JSON.parse(written.text) as { id: string; author: string };
    expect(note.author).toBe("session");

    expect((await client.projectNotes(projectId)).notes.map((row) => row.title)).toEqual(["Deploy"]);

    const read = await callTool(daemon, secret, "notes_list", { noteId: note.id });
    expect(JSON.parse(read.text).body).toBe("bun run ship");

    const projects = await callTool(daemon, secret, "notes_list", { projects: true });
    expect(JSON.parse(projects.text)).toEqual([{ id: projectId, name: "aurora" }]);
  });

  test("an unregistered project is refused here exactly as it is on the route", async () => {
    const { daemon, secret } = await connected();
    const refused = await callTool(daemon, secret, "notes_write", { projectId: "project_nothing", title: "Ghost" });
    expect(refused.isError).toBe(true);
  });

  test("an argument the wall's schema refuses never reaches a handler", async () => {
    const { daemon, projectId, secret } = await connected();
    const answered = await rpc(daemon, secret, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "notes_write", arguments: { projectId, title: 42 } },
    });
    const body = (await answered.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32602);
  });
});

describe("the delete fence", () => {
  test("an agent may delete an agent's note and may not delete the user's", async () => {
    const { daemon, client, projectId, secret } = await connected();

    const { note: theirs } = await client.createProjectNote(projectId, { title: "Mine", body: "hands off" });
    const refused = await callTool(daemon, secret, "notes_delete", { noteId: theirs.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/written by the user/);
    expect((await client.projectNote(projectId, theirs.id)).note.title).toBe("Mine");

    const mine = JSON.parse((await callTool(daemon, secret, "notes_write", { projectId, title: "Scratch" })).text) as { id: string };
    const deleted = await callTool(daemon, secret, "notes_delete", { noteId: mine.id });
    expect(deleted.isError).toBe(false);
    expect((await client.projectNotes(projectId)).notes.map((row) => row.title)).toEqual(["Mine"]);
  });
});
