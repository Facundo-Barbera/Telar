import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMPTY_SERVERS_CONFIG, ServersConfig } from "../src/schemas";
import { resolveServersConfig } from "../src/servers";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-servers-"));
const serversPath = path.join(root, "servers.yaml");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(yaml: string) {
  fs.writeFileSync(serversPath, yaml);
}
function clear() {
  fs.rmSync(serversPath, { force: true });
}

describe("resolveServersConfig", () => {
  test("absent servers.yaml → EMPTY_SERVERS_CONFIG (no throw, back-compat)", () => {
    clear();
    const cfg = resolveServersConfig(root);
    expect(cfg).toEqual(EMPTY_SERVERS_CONFIG);
    expect(cfg).toEqual({ version: 1, driver: "none", services: {} });
  });

  test("EMPTY_SERVERS_CONFIG === parse of an empty file", () => {
    write("{}\n");
    expect(resolveServersConfig(root)).toEqual(EMPTY_SERVERS_CONFIG);
    clear();
  });

  test("parses a full §4.1-style recipe", () => {
    write(`
version: 1
driver: host-process
services:
  api:
    command: bun run dev
    portStrategy: dynamic
    portInject:
      env: PORT
    readyCheck:
      kind: http
      path: /healthz
    healthcheck:
      kind: http
      path: /healthz
    restartPolicy:
      onCrash: true
      maxRestarts: 5
    reset: bun run db:reset
    env:
      DATABASE_URL: postgres://localhost:{db.port}/app
      SELF_URL: http://localhost:{port}
  worker:
    command: bun run worker
    portStrategy: fixed
    dependsOn:
      - api
    readyCheck:
      kind: command
      run: pgrep worker
`);
    const cfg = resolveServersConfig(root);
    expect(cfg.driver).toBe("host-process");
    expect(cfg.version).toBe(1);

    const api = cfg.services.api;
    expect(api.command).toBe("bun run dev");
    expect(api.portStrategy).toBe("dynamic");
    expect(api.portInject).toEqual({ env: "PORT" });
    expect(api.readyCheck).toEqual({ kind: "http", path: "/healthz", status: 200 }); // status default
    expect(api.healthcheck).toEqual({ kind: "http", path: "/healthz", status: 200, intervalMs: 5000 }); // defaults
    expect(api.restartPolicy).toEqual({ onCrash: true, maxRestarts: 5, backoffMs: 1000 }); // backoff default
    expect(api.reset).toBe("bun run db:reset");
    expect(api.env.SELF_URL).toBe("http://localhost:{port}");
    expect(api.dependsOn).toEqual([]); // default

    const worker = cfg.services.worker;
    expect(worker.portStrategy).toBe("fixed");
    expect(worker.dependsOn).toEqual(["api"]);
    expect(worker.readyCheck).toEqual({ kind: "command", run: "pgrep worker" });
    expect(worker.env).toEqual({}); // default

    clear();
  });

  test("malformed YAML → throws a file-pointed error", () => {
    write("services: [unterminated\n");
    expect(() => resolveServersConfig(root)).toThrow(/Malformed YAML in .*servers\.yaml/);
    clear();
  });

  test("schema-invalid (missing required portStrategy) → throws Invalid servers.yaml", () => {
    write(`
services:
  api:
    command: bun run dev
`);
    expect(() => resolveServersConfig(root)).toThrow(/Invalid servers\.yaml at .*servers\.yaml/);
    clear();
  });

  test("schema-invalid (bad driver enum) → throws", () => {
    write("driver: docker\n");
    expect(() => resolveServersConfig(root)).toThrow(/Invalid servers\.yaml/);
    clear();
  });

  test("PortInject strict union rejects an unknown variant key", () => {
    const parsed = ServersConfig.safeParse({
      services: { api: { command: "x", portStrategy: "dynamic", portInject: { port: "PORT" } } },
    });
    expect(parsed.success).toBe(false);
  });

  test("back-compat: none driver + empty services stands nothing up", () => {
    clear();
    const cfg = resolveServersConfig(root);
    expect(cfg.driver).toBe("none");
    expect(Object.keys(cfg.services)).toHaveLength(0);
  });

  test("empty / comment-only file degrades to the none default (not an error)", () => {
    for (const body of ["", "\n", "   ", "# just a comment\n"]) {
      write(body);
      expect(resolveServersConfig(root)).toEqual({
        version: 1,
        driver: "none",
        services: {},
      });
    }
    clear();
  });

  test("absent resolve returns a FRESH object (mutating it can't poison the next)", () => {
    clear();
    const a = resolveServersConfig(root);
    a.services.injected = { command: "x", portStrategy: "fixed", dependsOn: [], env: {} };
    const b = resolveServersConfig(root);
    expect(Object.keys(b.services)).toHaveLength(0);
  });

  test("env tolerates YAML-coerced scalars, normalized to string", () => {
    write(`
services:
  api:
    command: bun run dev
    portStrategy: fixed
    env:
      PORT: 8080
      DEBUG: true
      NAME: api
`);
    const env = resolveServersConfig(root).services.api.env;
    expect(env).toEqual({ PORT: "8080", DEBUG: "true", NAME: "api" });
    clear();
  });

  test("portInject arg + file variants and healthcheck command branch parse", () => {
    const parsedArg = ServersConfig.safeParse({
      services: {
        a: { command: "x", portStrategy: "dynamic", portInject: { arg: "--port {port}" } },
      },
    });
    expect(parsedArg.success).toBe(true);
    const parsedFile = ServersConfig.safeParse({
      services: {
        a: {
          command: "x",
          portStrategy: "dynamic",
          portInject: { file: ".env", template: "PORT={port}" },
          healthcheck: { kind: "command", run: "pgrep x" },
        },
      },
    });
    expect(parsedFile.success).toBe(true);
    if (parsedFile.success) {
      const hc = parsedFile.data.services.a.healthcheck;
      expect(hc).toEqual({ kind: "command", run: "pgrep x", intervalMs: 5000 });
    }
  });
});
