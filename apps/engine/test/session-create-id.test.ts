/**
 * A CALLER MAY MINT THE SESSION ID, AND SAYING IT TWICE IS A NO-OP — #495.
 *
 * WHY THE COCKPIT NEEDS THIS. A new conversation is a composer with nothing
 * behind it until the first message, and that message is what creates the
 * session — so the reader waits a round trip before the URL, the rail and the
 * transcript know which conversation they are about. Minting the id on the
 * client removes the wait: the address is the session's own from the moment
 * Send is pressed, and the POST reconciles behind it.
 *
 * AND THAT ONLY WORKS IF RE-EMISSION IS FREE. An id the client chose is an id
 * the client can send twice — a double-click, a retry after a flaky socket, a
 * component that remounted mid-flight. The engine already answers the second
 * one with the session it already has (`EngineStore.createSession` reads the
 * metadata document before writing), and this file is what stops that becoming
 * an accident: the behaviour has no test of its own, and it is load-bearing for
 * a whole client feature the day it regresses.
 *
 * THE OTHER HALF IS THE REFUSAL. "Already exists" must not mean "adopt it": an
 * id that belongs to ANOTHER project is a conflict, because silently handing
 * back somebody else's conversation is worse than either creating or refusing.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-create-id-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.registerProject({ id: "project_two", name: "Two", root: root() });
  return { daemon, client };
}

test("a caller's own id is the session's id", async () => {
  const { client } = await ready();
  // The shape the cockpit mints — `session_` plus a UUID with its dashes out,
  // which is also what the engine generates when nobody supplies one.
  const id = "session_c0ffee0000004f4b8f0e1d2c3b4a5960";
  const { session } = await client.createSession({ id, projectId: "project_one" });
  expect(session.id).toBe(id);
  await expect(client.session(id)).resolves.toMatchObject({ session: { id } });
});

test("re-emitting the same create is a silent no-op, not a second session", async () => {
  const { client } = await ready();
  const id = "session_double0000004f4b8f0e1d2c3b4a59";

  const first = await client.createSession({ id, projectId: "project_one", title: "Exoplanets" });
  // The double-click. Same id, same project, and deliberately a DIFFERENT title
  // — a second create is a repeat of the first request, not an edit, so the
  // session it answers with is the one that already exists.
  const second = await client.createSession({ id, projectId: "project_one", title: "Something else" });

  expect(second.session.id).toBe(first.session.id);
  expect(second.session.title).toBe("Exoplanets");
  // `createdAt` is the proof nothing was re-made: a fresh document would carry
  // the second call's clock, and the worktree would have been cut twice.
  expect(second.session.createdAt).toBe(first.session.createdAt);

  const { sessions } = await client.listSessions("project_one");
  expect(sessions.filter((entry) => entry.id === id)).toHaveLength(1);
});

test("a re-emission does not undo what happened in between", async () => {
  // The retry that arrives late: the first create landed, the cockpit renamed
  // the session off the first message, and only then did the duplicate POST go
  // out. Answering it from the stored document is what keeps the rename.
  const { client } = await ready();
  const id = "session_late00000004f4b8f0e1d2c3b4a59";

  await client.createSession({ id, projectId: "project_one", title: "Untitled" });
  await client.updateSession(id, { title: "Transit timing variations" });
  const again = await client.createSession({ id, projectId: "project_one", title: "Untitled" });

  expect(again.session.title).toBe("Transit timing variations");
});

test("the same id in ANOTHER project is refused rather than adopted", async () => {
  const { client } = await ready();
  const id = "session_owned00000004f4b8f0e1d2c3b4a5";

  await client.createSession({ id, projectId: "project_one" });
  const refused = await client.createSession({ id, projectId: "project_two" }).catch((error: EngineClientError) => error);

  // A conflict, and it names the reason. Handing back project_one's session
  // would be the same "silent no-op" one line up, applied where it is wrong:
  // the caller asked for a conversation in a project that would not have it.
  expect((refused as EngineClientError).status).toBe(409);
  expect((refused as EngineClientError).message).toMatch(/already owned by another project/i);
});

test("a caller that mints nothing still gets an id", async () => {
  // The id is OPTIONAL, and every existing caller — the MCP toolkit, an API
  // client, the engine's own `sessions` tools — goes on supplying none.
  const { client } = await ready();
  const { session } = await client.createSession({ projectId: "project_one" });
  expect(session.id).toMatch(/^session_[0-9a-f]{32}$/);
});
