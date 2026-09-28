import { afterEach, describe, expect, test } from "bun:test";
import { ExternalPluginManifest, parsePluginPanelView } from "../src/protocol/plugins";
import { parseToolName, registerPluginToolPrefixes } from "../src/protocol/tools";

const manifest = {
  id: "echo",
  api: 1,
  name: "Echo",
  version: "1",
  command: ["./server"],
  routes: { session: ["status", "clear"] },
  panels: [{ id: "status", label: "Status", verb: "status" }],
};

describe("panels in the manifest", () => {
  test("a panel drawn from a declared session verb is accepted", () => {
    expect(ExternalPluginManifest.parse(manifest).panels).toEqual([{ id: "status", label: "Status", verb: "status" }]);
  });

  test("a panel whose verb is not a declared route is refused", () => {
    const parsed = ExternalPluginManifest.safeParse({ ...manifest, panels: [{ id: "status", label: "Status", verb: "missing" }] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["panels", 0, "verb"]);
  });

  test("two panels with one id, and a route named tool, are refused", () => {
    const twice = { ...manifest, panels: [manifest.panels[0], manifest.panels[0]] };
    expect(ExternalPluginManifest.safeParse(twice).success).toBe(false);
    const shadow = { ...manifest, routes: { session: ["tool"] }, panels: [] };
    expect(ExternalPluginManifest.safeParse(shadow).error?.issues[0]?.message).toContain("reserved");
  });
});

describe("a panel's blocks", () => {
  test("every kind parses", () => {
    const blocks = [
      { type: "heading", text: "Jobs" },
      { type: "text", text: "**two** running", markdown: true },
      { type: "keyValue", items: [{ key: "queue", value: 2 }, { key: "paused", value: false }] },
      { type: "table", columns: ["id", "state"], rows: [["a", "done"], ["b", null]] },
      { type: "log", lines: ["started", "finished"] },
      { type: "action", label: "Clear", verb: "clear", input: { all: true }, confirm: "Clear every job?" },
    ];
    expect(parsePluginPanelView({ blocks })).toEqual({ blocks: blocks as never, skipped: 0 });
  });

  test("an unknown or malformed block is dropped and counted; the rest still draw", () => {
    const view = parsePluginPanelView({
      blocks: [{ type: "heading", text: "Jobs" }, { type: "chart", data: [] }, { type: "action", label: "Go", verb: "Not A Verb" }],
    });
    expect(view.blocks).toEqual([{ type: "heading", text: "Jobs" }]);
    expect(view.skipped).toBe(2);
  });

  test("an answer without blocks draws nothing rather than failing", () => {
    expect(parsePluginPanelView(null)).toEqual({ blocks: [], skipped: 0 });
    expect(parsePluginPanelView({ blocks: "no" })).toEqual({ blocks: [], skipped: 0 });
  });
});

describe("an installed plugin's tool prefix", () => {
  afterEach(() => registerPluginToolPrefixes([]));

  test("is untyped until registered, then typed like a bundled one", () => {
    expect(parseToolName("mcp__telar__echo_say").capability).toBeUndefined();
    registerPluginToolPrefixes(["echo"]);
    expect(parseToolName("mcp__telar__echo_say")).toEqual({ server: "telar", tool: "echo_say", capability: "echo" });
    // Only on Telar's own server.
    expect(parseToolName("mcp__other__echo_say").capability).toBeUndefined();
  });

  test("registering replaces the previous list", () => {
    registerPluginToolPrefixes(["echo"]);
    registerPluginToolPrefixes(["other"]);
    expect(parseToolName("mcp__telar__echo_say").capability).toBeUndefined();
  });
});
