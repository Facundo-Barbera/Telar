import { describe, expect, test } from "bun:test";
import {
  canonicalEnvPatch,
  canonicalJson,
  canonicalServers,
  changedFields,
  fieldDigests,
  resolveChildEnv,
} from "./identity";

describe("canonical identity", () => {
  test("key order is NOT identity — the defect that spawned a second CLI per reordered env", () => {
    const a = { env: { A: "1", B: "2" }, headers: { X: "x", Y: "y" } };
    const b = { headers: { Y: "y", X: "x" }, env: { B: "2", A: "1" } };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test("an explicit deletion is not an absence", () => {
    expect(JSON.stringify({})).toBe(JSON.stringify({ ANTHROPIC_API_KEY: undefined }));
    expect(canonicalJson({})).not.toBe(canonicalJson({ ANTHROPIC_API_KEY: undefined }));
    expect(canonicalJson({ K: undefined })).not.toBe(canonicalJson({ K: "" }));
  });

  test("array order IS identity — a command's arguments are a sequence, not a set", () => {
    expect(canonicalJson(["--port", "1"])).not.toBe(canonicalJson(["1", "--port"]));
  });

  test("servers are deduplicated last-wins then sorted, matching what the record downstream keeps", () => {
    const listed = canonicalServers([
      { id: "b", enabled: true, spec: { transport: "stdio", command: "b" } },
      { id: "a", enabled: true, spec: { transport: "stdio", command: "first" } },
      { id: "a", enabled: true, spec: { transport: "stdio", command: "last" } },
    ]);
    expect(listed?.map((server) => server.id)).toEqual(["a", "b"]);
    expect(listed?.[0]?.spec).toMatchObject({ command: "last" });
    expect(canonicalServers(undefined)).toBeNull();
    expect(canonicalServers([])).toEqual([]);
  });

  test("resolveChildEnv DELETES a key the patch maps to undefined, rather than leaving it present", () => {
    const resolved = resolveChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "ambient" }, { ANTHROPIC_API_KEY: undefined, CLAUDE_CONFIG_DIR: "/tmp/cfg" });
    expect(Object.hasOwn(resolved!, "ANTHROPIC_API_KEY")).toBeFalse();
    expect(resolved).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/tmp/cfg" });
  });

  test("no patch at all leaves the SDK's own inheritance alone", () => {
    expect(resolveChildEnv({ PATH: "/bin" })).toBeUndefined();
    expect(resolveChildEnv({ PATH: "/bin" }, {})).toEqual({ PATH: "/bin" });
  });

  test("the env patch as identity keeps the deletion and drops the worker's own environment", () => {
    expect(canonicalEnvPatch({ A: undefined }, { B: "1" })).toEqual({ A: undefined, B: "1" });
    expect(canonicalEnvPatch(undefined, undefined)).toBeNull();
  });

  test("a reuse diagnostic names the changed fields and nothing else", () => {
    const before = fieldDigests({ cwd: "/a", env: { KEY: "secret-one" } });
    const after = fieldDigests({ cwd: "/a", env: { KEY: "secret-two" } });
    expect(changedFields(before, after)).toEqual(["env"]);
    expect(JSON.stringify(after)).not.toContain("secret-two");
  });
});
