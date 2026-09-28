/**
 * A REAL EXTERNAL PLUGIN, WRITTEN INTO A TEMP FOLDER — the manifest and a
 * stdio JSON-RPC server a test can install and a daemon can spawn. It answers
 * `initialize`, one tool (`echo_say`) and one session route (`status`), and
 * exits when stdin closes, so it never outlives the test that started it.
 */
import fs from "node:fs";
import path from "node:path";

const SERVER = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stderr.write("echo plugin started\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  if (method === "tools/call") return send({ id, result: { content: [{ type: "text", text: "echo: " + params.arguments.text }] } });
  if (method === "telar/route") return send({ id, result: { scope: params.scope, verb: params.verb, sessionId: params.sessionId, projectId: params.projectId } });
  send({ id, error: { code: -32601, message: "no method " + method } });
});
process.stdin.on("end", () => process.exit(0));
`;

export const ECHO_MANIFEST = {
  id: "echo",
  api: 1,
  name: "Echo",
  version: "0.1.0",
  command: [process.execPath, "server.js"],
  toolPrefix: "echo",
  tools: [
    {
      name: "echo_say",
      description: "Say something back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
  settingsSchema: { type: "object", properties: { greeting: { type: "string", title: "Greeting" } } },
  routes: { session: ["status"] },
  panels: [{ id: "status", label: "Status", verb: "status" }],
};

/** Write a plugin folder under `pluginsDir`; `manifest` may be raw text to test a broken file. */
export function writePlugin(pluginsDir: string, folder: string, manifest: unknown = ECHO_MANIFEST): string {
  const dir = path.join(pluginsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "server.js"), SERVER);
  return dir;
}
