/**
 * A PLUGIN'S PROJECT AND MACHINE DOORS.
 *
 *   routing    `/v2/projects/:id/plugins/<id>/<verb>` and `/v2/plugins/<id>/<verb>`
 *              reach the plugin's own table, method and `:params` included
 *   aliases    the old `/v2/.../{data-science,latex}/*` paths answer exactly as
 *              the generic doors do when the plugin is on, and stay ungated
 *   refusal    off for this Mac refuses every scope; off for a project refuses
 *              project verbs except the ones used to choose before turning on
 *
 * Temp engine root and projects; nothing is installed and no provider runs.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { matchPluginRoute } from "./scoped-routes";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-scoped-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" };
  const call = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`${base}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as { error?: { code: string; message: string } } & Record<string, unknown> };
  };
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  return { client, call };
}

test("the matcher takes method and path, and captures `:params`", () => {
  const table = { "GET jobs/:id": "read", "DELETE jobs/:id": "cancel", "GET toolchain": "toolchain" };
  expect(matchPluginRoute(table, "GET", "jobs/job_1")).toEqual({ route: "read", params: { id: "job_1" } });
  expect(matchPluginRoute(table, "DELETE", "jobs/job%201")).toEqual({ route: "cancel", params: { id: "job 1" } });
  expect(matchPluginRoute(table, "POST", "toolchain")).toBeUndefined();
  expect(matchPluginRoute(table, "GET", "jobs")).toBeUndefined();
  expect(matchPluginRoute(table, "GET", "jobs/a/b")).toBeUndefined();
});

test("machine scope: the generic door and the old path give the same answer", async () => {
  const { call } = await engine();
  const generic = await call("GET", "/v2/plugins/latex/managed");
  const legacy = await call("GET", "/v2/latex/managed");
  expect(generic.status).toBe(200);
  expect(generic).toEqual(legacy);
  expect(generic.body).toHaveProperty("managed");

  // A `:param` verb reaches the store: an unknown job is the store's own 404.
  const job = await call("GET", "/v2/plugins/data-science/jobs/job_missing?after=0");
  expect(job.status).toBe(404);
  expect(job).toEqual(await call("GET", "/v2/data-science/jobs/job_missing?after=0"));
});

test("an unknown plugin or verb is a 404 about the plugin", async () => {
  const { call } = await engine();
  expect((await call("GET", "/v2/plugins/nope/toolchain")).body.error?.message).toBe("no plugin nope");
  const verb = await call("POST", "/v2/plugins/latex/toolchain");
  expect(verb.status).toBe(404);
  expect(verb.body.error?.message).toBe("plugin latex has no POST toolchain");
});

test("a bad body is refused in the old routes' own words, at both doors", async () => {
  const { call } = await engine();
  for (const pathname of ["/v2/plugins/latex/bootstrap", "/v2/latex/bootstrap"]) {
    const refused = await call("POST", pathname, { what: "nonsense" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "invalid_request", message: "not a valid bootstrap request" });
  }
});

test("off for this Mac refuses every generic scope; the old paths stay ungated", async () => {
  const { client, call } = await engine();
  await client.updateMachinePlugins({ latex: { enabled: false } });

  const machine = await call("GET", "/v2/plugins/latex/managed");
  expect(machine.status).toBe(400);
  expect(machine.body.error).toEqual({ code: "invalid_request", message: "latex is turned off for this Mac" });
  // Even a verb that answers before a project turns LaTeX on.
  const choosing = await call("GET", "/v2/projects/project_one/plugins/latex/distributions");
  expect(choosing.body.error?.message).toBe("latex is turned off for this Mac");

  // The alias keeps the behaviour a released client relies on.
  expect((await call("GET", "/v2/latex/managed")).status).toBe(200);
});

test("off for a project refuses its project verbs, except the ones used to choose", async () => {
  const { client, call } = await engine();
  const refused = await call("GET", "/v2/projects/project_one/plugins/latex/packages");
  expect(refused.status).toBe(400);
  expect(refused.body.error).toEqual({ code: "invalid_request", message: "latex is not enabled for this project" });
  const install = await call("POST", "/v2/projects/project_one/plugins/data-science/packages", { add: ["pandas"] });
  expect(install.body.error?.message).toBe("data-science is not enabled for this project");

  // Choosing a distribution comes before turning LaTeX on.
  const choosing = await call("GET", "/v2/projects/project_one/plugins/latex/distributions");
  expect(choosing.body.error?.message ?? "").not.toContain("not enabled");

  // Turned on, the project verb answers — and answers as the old path does.
  // @ts-expect-error deprecated alias the engine still accepts
  await client.updateProject("project_one", { latex: { enabled: true, toolchain: { kind: "texlive", path: "/bin/echo" } } });
  const generic = await call("GET", "/v2/projects/project_one/plugins/latex/packages");
  expect(generic.body.error?.message ?? "").not.toContain("not enabled");
  expect(generic).toEqual(await call("GET", "/v2/projects/project_one/latex/packages"));
});

test("an unknown project is the store's 404 at project scope", async () => {
  const { call } = await engine();
  const missing = await call("GET", "/v2/projects/project_nope/plugins/latex/packages");
  expect(missing.status).toBe(404);
  expect(missing.body.error?.code).toBe("not_found");
});
