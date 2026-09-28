import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DirectoryListing } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { matchRoute } from "../../platform/http/router";
import { filesRoutes } from "./routes";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};

const ask = (query: string, home: string) => {
  const { route, params } = matchRoute(filesRoutes({ home, mounts: [] }), "GET", "/v2/fs")!;
  return route.handle({ body: {}, params, query: new URLSearchParams(query) });
};

test("lists home's folders, badging checkouts and hiding dotfolders unless asked", () => {
  const home = scratch("telar-fs-home-");
  fs.mkdirSync(path.join(home, "code", ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, ".secret"));
  fs.writeFileSync(path.join(home, "notes.txt"), "not a folder");

  const listing = ask("", home);
  expect(listing.status).toBe(200);
  expect((listing.body as DirectoryListing).path).toBe(home);
  expect((listing.body as DirectoryListing).dirs.map((entry) => [entry.name, entry.git])).toEqual([["code", true]]);
  expect((ask("?hidden=1", home).body as DirectoryListing).dirs.map((entry) => entry.name)).toEqual([".secret", "code"]);
});

test("a missing path is a 404, or its nearest folder when asked", () => {
  const home = scratch("telar-fs-home-");
  const gone = encodeURIComponent(path.join(home, "gone"));
  expect(ask(`?path=${gone}`, home)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  expect((ask(`?nearest=1&path=${gone}`, home).body as DirectoryListing).path).toBe(home);
});

test("the engine serves it behind its token and refuses paths outside home and the mounts", async () => {
  const daemon = await startEngine({ models: stubModels, engineRoot: scratch("telar-fs-engine-") });
  daemons.push(daemon);
  const get = (route: string, token = daemon.discovery.token) =>
    fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, { headers: { authorization: `Bearer ${token}` } });

  const outside = await get(`/v2/fs?path=${encodeURIComponent(scratch("telar-fs-outside-"))}`);
  expect(outside.status).toBe(400);
  expect(((await outside.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  expect((await get("/v2/fs", "wrong")).status).toBe(401);
});
