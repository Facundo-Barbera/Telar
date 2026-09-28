import { expect, test } from "bun:test";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

test("only enabled MCP servers ride the claim, and disabling one keeps its configuration", () => {
  const { store } = readyStore();
  store.mcpServers.save({ id: "linear", label: "Linear", spec: { transport: "http", url: "https://mcp.linear.app/sse" } });
  store.mcpServers.save({ id: "local_tools", spec: { transport: "stdio", command: "node", args: ["server.js"] } });
  expect(store.mcpServers.list().map((server) => server.id)).toEqual(["linear", "local_tools"]);
  // The label defaults to the id, which is also the name the provider addresses
  // its tools by.
  expect(store.mcpServers.list()[1]!.label).toBe("local_tools");

  store.mcpServers.save({ id: "linear", enabled: false, spec: { transport: "http", url: "https://mcp.linear.app/sse" } });
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hi" });
  expect(store.claims.claimNextTurn("worker_one")?.mcpServers?.map((server) => server.id)).toEqual(["local_tools"]);

  // Off is a state, not deletion: the configuration survives so it can come back.
  expect(store.mcpServers.list().find((server) => server.id === "linear")?.spec).toEqual({
    transport: "http",
    url: "https://mcp.linear.app/sse",
  });
  expect(store.mcpServers.remove("linear")).toBe(true);
  expect(store.mcpServers.remove("linear")).toBe(false);
  expect(() => store.mcpServers.save({ id: "bad", spec: { transport: "carrier-pigeon" } })).toThrow(EngineStateError);
});

test("an MCP server belongs to a project or to the machine, and the project's wins", () => {
  const { store } = readyStore();
  // A distinct root: the registry refuses two projects pointing at one checkout.
  // It must be distinct AFTER canonicalization, which os.tmpdir() is not —
  // readyStore registers project_one at "/tmp", and on Linux os.tmpdir() IS
  // /tmp, so this collided and threw "already registered" in CI while passing
  // on macOS, where os.tmpdir() is a per-user /var/folders path.
  store.projectRegistry.register({ id: "project_two", name: "Two", root: root() });
  store.mcpServers.save({ id: "linear", spec: { transport: "http", url: "https://global.example" } });
  store.mcpServers.save({ id: "browser", spec: { transport: "stdio", command: "node" } });
  store.mcpServers.save({ id: "linear", projectId: "project_one", spec: { transport: "http", url: "https://one.example" } });

  // Scope is a property, and the three reads answer three different questions.
  expect(store.mcpServers.list({ projectId: null }).map((server) => server.id)).toEqual(["linear", "browser"]);
  expect(store.mcpServers.list({ projectId: "project_one" }).map((server) => server.spec)).toEqual([
    { transport: "http", url: "https://one.example" },
  ]);
  expect(store.mcpServers.list({ projectId: "project_two" })).toEqual([]);

  // THE PAIR IS THE KEY: the project's `linear` did not overwrite the global
  // one, and a session on that project sees the project's instead.
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimNextTurn("worker_one");
  expect(claimed?.mcpServers?.map((server) => [server.id, server.spec])).toEqual([
    ["browser", { transport: "stdio", command: "node" }],
    ["linear", { transport: "http", url: "https://one.example" }],
  ]);

  // …and deleting the project's leaves the global one standing, which an
  // id-only match would not have done.
  expect(store.mcpServers.remove("linear", "project_one")).toBe(true);
  expect(store.mcpServers.list({ projectId: null }).map((server) => server.id)).toEqual(["linear", "browser"]);
  expect(() => store.mcpServers.save({ id: "x", projectId: "nobody", spec: { transport: "stdio", command: "node" } })).toThrow(
    EngineStateError,
  );
});
