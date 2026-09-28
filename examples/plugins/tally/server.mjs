// Tally — an example Telar plugin. One tool (tally_count), one setting (step)
// and one panel (Counts). Speaks newline-delimited JSON-RPC 2.0 on stdio; see
// docs/design/plugins-contract.md, "External plugins".
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const stateFile = path.join(process.env.TELAR_PLUGIN_STATE ?? ".", "counts.json");
const log = (line) => process.stderr.write(`${line}\n`);

/** { [projectId]: { counts: { [label]: number }, history: string[] } } */
function load() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function project(state, projectId) {
  return (state[projectId] ??= { counts: {}, history: [] });
}

function count(projectId, label, settings) {
  const state = load();
  const entry = project(state, projectId);
  const step = Number.isInteger(settings?.step) ? settings.step : 1;
  entry.counts[label] = (entry.counts[label] ?? 0) + step;
  entry.history = [...entry.history, `${new Date().toISOString()} ${label} +${step}`].slice(-50);
  save(state);
  return entry.counts[label];
}

function panel(projectId, settings) {
  const entry = project(load(), projectId);
  const rows = Object.entries(entry.counts).sort(([a], [b]) => a.localeCompare(b));
  return {
    blocks: [
      { type: "heading", text: "Counts" },
      rows.length === 0
        ? { type: "text", text: "Nothing counted yet. Ask the agent to **tally** something.", markdown: true }
        : { type: "table", columns: ["Label", "Count"], rows },
      { type: "keyValue", items: [{ key: "Step", value: Number.isInteger(settings?.step) ? settings.step : 1 }] },
      { type: "log", lines: entry.history },
      ...(rows.length > 0 ? [{ type: "action", label: "Reset", verb: "reset", confirm: "Reset every count in this project?" }] : []),
    ],
  };
}

function reset(projectId) {
  const state = load();
  delete state[projectId];
  save(state);
  return { ok: true };
}

function handle(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tally", version: "0.1.0" } };
    case "tools/call": {
      const { projectId, settings } = params._meta?.telar ?? {};
      if (params.name !== "tally_count") throw new Error(`no tool ${params.name}`);
      const label = String(params.arguments?.label ?? "").trim();
      if (!label) return { content: [{ type: "text", text: "A label is required." }], isError: true };
      return { content: [{ type: "text", text: `${label}: ${count(projectId, label, settings)}` }] };
    }
    case "telar/route":
      if (params.verb === "counts") return panel(params.projectId, params.settings);
      if (params.verb === "reset") return reset(params.projectId);
      throw new Error(`no route ${params.verb}`);
    default:
      throw new Error(`no method ${method}`);
  }
}

log("tally started");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return log(`not JSON: ${line}`);
  }
  if (message.id === undefined) return; // a notification
  const reply = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n`);
  try {
    reply({ result: handle(message.method, message.params ?? {}) });
  } catch (error) {
    reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
});
process.stdin.on("end", () => process.exit(0));
