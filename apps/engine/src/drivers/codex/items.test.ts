import { expect, test } from "bun:test";
import { codexApprovalRequest, codexItemDetail, codexUsage } from "./items";

test("a usage update for the wrong shape reports nothing rather than zeros", () => {
  expect(codexUsage({ tokenUsage: { total: { inputTokens: 10 }, modelContextWindow: 400000 } })).toBeUndefined();
  expect(codexUsage({})).toBeUndefined();
});

test("an MCP tool approval is an elicitation, and the engine answers it", () => {
  const approval = codexApprovalRequest("mcpServer/elicitation/request", {
    threadId: "019ffda0-1892-7510-989e-5efb17c4de3b",
    turnId: "019ffda0-20dc-7961-914a-26b1a34ed12f",
    serverName: "probe",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "Answers pong.",
      tool_params: { query: "x" },
    },
    message: 'Allow the probe MCP server to run tool "ping"?',
    requestedSchema: { type: "object", properties: {} },
  });

  expect(approval?.kind).toBe("tool_call");
  expect(approval?.detail).toEqual({
    kind: "tool_call",
    call: { name: "mcp__probe__ping", server: "probe", input: { query: "x" } },
  });
});

test("an elicitation that is not an approval is not one to answer", () => {
  expect(
    codexApprovalRequest("mcpServer/elicitation/request", {
      serverName: "probe",
      mode: "url",
      message: "Open this to link your account",
      url: "https://example.com/link",
      elicitationId: "e1",
    }),
  ).toBeNull();
});

test("a file change that names no path is titled neutrally, never with the placeholder", () => {
  expect(codexItemDetail({ type: "fileChange", id: "fc_1", changes: [] })?.title).toBe("File change");
  expect(codexItemDetail({ type: "fileChange", id: "fc_2", changes: [{ path: "src/a.ts", kind: { type: "update" } }] })?.title).toBe("src/a.ts");
});
