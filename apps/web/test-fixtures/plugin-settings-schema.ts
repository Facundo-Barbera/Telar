/**
 * A PLUGIN'S SETTINGS AS THE ENGINE PUBLISHES THEM — the JSON Schema zod's
 * `toJSONSchema` writes, `.meta()` keys included — covering every kind the
 * generated pane draws and the two it leaves to a bespoke block.
 */
export const FIXTURE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    loud: { type: "boolean", title: "Shout", description: "Answer in capitals." },
    tone: { type: "string", enum: ["warm", "dry"], default: "warm", title: "Tone" },
    greeting: { type: "string", minLength: 1, title: "Greeting", description: "What it answers with.", inherits: "greeting" },
    folder: { type: "string", widget: "path", title: "Output folder", info: "Relative to the checkout." },
    slowMs: { type: "integer", minimum: 0, maximum: 60000, default: 50 },
    ratio: { anyOf: [{ type: "number", maximum: 1 }, { type: "null" }], title: "Ratio" },
    // Left to a bespoke block: a nested choice and a list.
    toolchain: { type: "object", properties: { path: { type: "string" } } },
    stack: { type: "array", items: { type: "string" } },
  },
};
