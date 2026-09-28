import { afterEach, describe, expect, test } from "bun:test";
import { assertTelarToolNames, parseToolName, qualifyTelarTool, TELAR_CAPABILITIES } from "@telar/engine-client";
import { type SessionsCapability, collectSessionsWallTools } from "..";
import { toolInputSchema } from "../../agent-tools";
import { cleanUp, wall, engine } from "./test-helpers";

afterEach(cleanUp);

// In registration order; the list grows at the end rather than reordering.
const WALL_NAMES = [
  "sessions_list",
  "sessions_create",
  "sessions_send",
  "sessions_read",
  "sessions_status",
  "sessions_stop",
  "sessions_settle",
  "sessions_subscribe",
  "sessions_requests",
  "sessions_resolve_request",
  "sessions_schedule",
];

describe("what the wall is", () => {
  test("exactly eleven tools, every one declaring the `sessions` capability in its name", () => {
    const { store } = engine();
    const names = [...wall(store).keys()];
    // Pinned as a set: the socket's parity test then requires each on the socket too.
    expect(names).toEqual(WALL_NAMES);
    expect(() => assertTelarToolNames(names)).not.toThrow();
    expect(TELAR_CAPABILITIES).toContain("sessions");
    expect(parseToolName(qualifyTelarTool("sessions_create")).capability).toBe("sessions");
  });

  test("nothing on this wall lands work — no accept, no merge, no archive, no delete", () => {
    const { store } = engine();
    const tools = [...wall(store).values()];
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/accept|approve|merge|land|ship|deliver|promote|finish|complete|done|close|archive|delete|remove/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
    for (const rogue of ["sessions_accept", "sessions_merge", "sessions_archive", "sessions_delete"]) {
      expect(rogue).toMatch(/accept|approve|merge|land|ship|deliver|promote|finish|complete|done|close|archive|delete|remove/);
    }
  });

  test("the prose says what no check here can enforce: this is not a way around a refusal", () => {
    const { store } = engine();
    const tools = wall(store);
    for (const name of ["sessions_create", "sessions_send", "sessions_resolve_request"]) {
      expect(tools.get(name)!.description).toContain("Never hand a peer work you were refused");
    }
    expect(tools.get("sessions_list")!.description).not.toContain("refused");
  });

  test("the journal read names its cheaper views, and its view parameter offers each one", () => {
    const { store } = engine();
    const read = wall(store).get("sessions_read")!;
    for (const cheaper of ["outline", "answer", "steps", "step", "grep"]) {
      expect(read.description).toContain(cheaper);
    }
    expect(read.description).toContain("raw journal");
    expect(JSON.stringify(toolInputSchema(read.shape))).toContain('"enum":["summary","outline","answer","steps","step","events","grep","diff"]');
  });
});

describe("the shape of the wall", () => {
  test("eleven tools, every one of them a `sessions_` verb", () => {
    const names = collectSessionsWallTools({} as SessionsCapability).map((tool) => tool.name);
    expect(names.length).toBe(11);
    for (const name of names) {
      expect(name.startsWith("sessions_")).toBe(true);
      expect(qualifyTelarTool(name)).toBe(`mcp__telar__${name}`);
    }
    expect(names).not.toContain("display_open");
    expect(names).not.toContain("warp");
  });
});
