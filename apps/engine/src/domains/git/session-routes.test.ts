import { expect, test } from "bun:test";
import fs from "node:fs";
import type http from "node:http";
import { EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";
import { sessionGitRoutes } from "./session-routes";

const { root } = useTempStores();

test("the status answers 304 to its own tag and 200 once the folder changed", async () => {
  let clock = 100;
  let stdout = "# branch.oid abc\0";
  const store = new EngineStore(root(), () => clock, { git: () => ({ status: 0, stdout, stderr: "" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  const route = sessionGitRoutes(store).find((candidate) => String(candidate.path).includes("status"))!;
  const ask = async (etag?: string) =>
    (await route.handle({
      params: ["session_one"],
      body: {},
      query: new URLSearchParams(),
      request: { headers: etag ? { "if-none-match": etag } : {} } as http.IncomingMessage,
      response: {} as http.ServerResponse,
    }))!;

  const first = await ask();
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ dirtyFiles: 0 });
  const tag = first.headers!.etag!;

  stdout = "# branch.oid abc\0? new.ts\0";
  store.workspaceReads.forgetUnder(store.projectRegistry.get("project_one").root);
  clock += 3_000;
  const moved = await ask(tag);
  expect(moved.status).toBe(200);
  expect(moved.body).toEqual({ dirtyFiles: 1 });

  const same = await ask(moved.headers!.etag);
  expect(same.status).toBe(304);
});
