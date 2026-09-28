import { expect, test } from "bun:test";
import type { DriverRun } from "../contract";
import { mcp, PEER } from "../../../test/codex-harness";
import { codexMcpServers, codexNotificationInstruction, codexSandboxPolicy, codexThreadParams, codexTurnInput, defaultThreadConfig } from "./thread";

test("an image attachment becomes a localImage element; anything else is named in the text", () => {
  const input = codexTurnInput("look", [
    { id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" },
    { id: "att_2", name: "notes.md", mediaType: "text/markdown", bytes: 9, path: "/tmp/notes.md" },
  ]);
  expect(input[1]).toEqual({ type: "localImage", path: "/tmp/shot.png" });
  expect(String((input[0] as { text: string }).text)).toContain("notes.md (text/markdown) at /tmp/notes.md");
  expect(input[0]).toMatchObject({ type: "text", text_elements: [] });
});

test("an image-only message is one localImage and no text item", () => {
  const shot = { id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" };
  expect(codexTurnInput("", [shot])).toEqual([{ type: "localImage", path: "/tmp/shot.png" }]);
  expect(codexTurnInput(" \n", [shot])).toEqual([{ type: "localImage", path: "/tmp/shot.png" }]);
});

test("the translation names Codex's fields, not the contract's", () => {
  expect(codexMcpServers([mcp("events", { transport: "sse", url: "https://mcp.example.com/sse" })])).toEqual({
    events: { url: "https://mcp.example.com/sse" },
  });
  expect(codexMcpServers([mcp("bare", { transport: "stdio", command: "node", args: [], env: {} })])).toEqual({
    bare: { command: "node" },
  });
  expect(codexMcpServers([])).toBeUndefined();
  expect(codexMcpServers(undefined)).toBeUndefined();
});

test("a wake and a parked request say which they are, in the header", () => {
  const wake = { ...PEER, kind: "wake" as const, wakeKind: "turn_completed" as const };
  expect(codexNotificationInstruction(wake, "body")).toContain("A session this one subscribed to did something.");
  const request = { ...PEER, kind: "request" as const, wakeKind: "request_opened" as const };
  expect(codexNotificationInstruction(request, "body")).toContain("is waiting on a request");
});

test("the sandbox policy follows the thread's sandbox", () => {
  expect(codexSandboxPolicy("danger-full-access", "/x")).toEqual({ type: "dangerFullAccess" });
  expect(codexSandboxPolicy("read-only", "/x")).toEqual({ type: "readOnly", networkAccess: false });
});

test("the orientation leads the developer instructions, and a session without one sends none", () => {
  const thread = { cwd: "/tmp/project", model: "gpt-5.5", config: defaultThreadConfig(false), windowConfig: {} };
  const run = (extra: Partial<DriverRun>) => ({ prompt: "hi", signal: new AbortController().signal, onObservations: async () => {}, ...extra }) as DriverRun;
  const oriented = codexThreadParams(run({ orientation: "You are in Telar.", mainBriefing: "You coordinate." }), thread);
  expect(oriented.params.developerInstructions).toBe("You are in Telar.\n\nYou coordinate.");
  expect("developerInstructions" in codexThreadParams(run({}), thread).params).toBeFalse();
});
