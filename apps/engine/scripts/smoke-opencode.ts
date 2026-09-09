/** Isolated real CLI + SDK smoke; a local fake model avoids credentials and paid calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createOpenCodeDriver } from "../src/opencode/driver";
import { OPENCODE_VERSION } from "../src/opencode/version";
const binaryPath = process.argv[2];
if (!binaryPath) throw new Error(`Usage: bun apps/engine/scripts/smoke-opencode.ts /path/to/opencode-${OPENCODE_VERSION}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-opencode-smoke-"));
let modelCalls = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("unexpected", { status: 404 });
  modelCalls++;
  const body = await request.json() as { stream?: boolean };
  const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
  if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello from the local fixture." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello from " }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "the local fixture." }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
const driver = createOpenCodeDriver({ pollMs: 50 });
try {
  const result = await driver.run({ sessionId: "session_smoke", runId: "run_smoke", binaryPath: path.resolve(binaryPath), cwd: root,
    prompt: "Reply with the fixture greeting", model: "fixture/fixture", signal: AbortSignal.timeout(60_000),
    env: {
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "fixture/fixture", small_model: "fixture/fixture", provider: {
        fixture: { npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture" },
          models: { fixture: { name: "Fixture", limit: { context: 128000, output: 8192 } } } },
      } }),
    }, onObservations: async () => {},
  });
  assert.equal(result.text, "Hello from the local fixture.");
  assert.ok(result.providerSessionId);
  assert.ok(modelCalls > 0);
  console.log(JSON.stringify({ version: OPENCODE_VERSION, modelCalls, text: result.text, providerSessionRecorded: !!result.providerSessionId }));
} finally {
  driver.dispose?.(); server.stop(true);
  await Bun.sleep(1_500);
  fs.rmSync(root, { recursive: true, force: true });
}
