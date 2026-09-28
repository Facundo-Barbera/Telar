import { expect, test } from "bun:test";
import { approxTokens, telarToolCost } from "./agent-tools-cost";

const schema = { type: "object", properties: { sessionId: { type: "string" } } };

test("an Anthropic request with full schemas counts only Telar's tools", () => {
  const body = {
    tools: [
      { name: "Bash", input_schema: schema },
      { name: "mcp__telar__sessions_read", input_schema: schema },
      { name: "mcp__telar-browser__browser_click", input_schema: schema },
    ],
    messages: [],
  };
  const cost = telarToolCost(body);
  expect(cost.fullSchemas).toBe(2);
  expect(cost.fullSchemaBytes).toBe(JSON.stringify(body.tools[1]).length + JSON.stringify(body.tools[2]).length);
  expect(cost.deferredNames).toBe(0);
});

test("deferred Telar tools are counted once by name from the messages", () => {
  const listing = "mcp__telar__sessions_read\nmcp__telar__notes_list\nmcp__telar__sessions_read";
  const cost = telarToolCost({ tools: [{ name: "ToolSearch" }], messages: [{ role: "system", content: [{ type: "text", text: listing }] }] });
  expect(cost.fullSchemas).toBe(0);
  expect(cost.deferredNames).toBe(2);
  expect(cost.deferredNameBytes).toBe("mcp__telar__sessions_read\nmcp__telar__notes_list".length);
});

test("OpenAI chat tools are named through their function", () => {
  const cost = telarToolCost({ tools: [{ function: { name: "telar_sessions_read" } }, { function: { name: "bash" } }] });
  expect(cost.fullSchemas).toBe(1);
});

test("a Responses request that only names Telar's servers carries no Telar schemas", () => {
  const cost = telarToolCost({ tools: [{ name: "exec_command" }], input: [{ role: "user", content: "hi" }] });
  expect(cost).toMatchObject({ fullSchemas: 0, deferredNames: 0 });
  expect(approxTokens(4100)).toBe(1000);
});
