/**
 * WHICH CONNECTION A MODEL RUNS THROUGH — OpenCode's `provider/model` routing,
 * read for a picker.
 *
 * OpenCode multiplexes CONNECTIONS: one login can reach OpenAI directly, the
 * OpenCode Go gateway, Bedrock, and more — and the same model often exists on
 * several of them (`openai/gpt-5.6-luna` and `opencode-go/gpt-5.6-luna` are
 * two routes to one model, billed and rate-limited differently). The row id IS
 * the route (apps/engine/src/opencode/driver.ts splits it back into
 * `providerID`/`modelID` on the wire), so nothing here rewrites an id — this
 * module only READS one so the picker can say which connection a row uses.
 *
 * NAMES ARE OPENCODE'S OWN. The labels below are the `name` fields from
 * models.dev — the provider database OpenCode itself resolves connections
 * against (inspected from OpenCode's cache of it on this machine, 2026-09-10:
 * `openai` → "OpenAI", `opencode` → "OpenCode Zen", `opencode-go` →
 * "OpenCode Go", `amazon-bedrock` → "Amazon Bedrock"). A connection the map
 * does not know falls back to title-casing its id rather than hiding it.
 */

export type ModelRoute = {
  /** The connection's id — OpenCode's `providerID` (`openai`, `opencode-go`). */
  connection: string;
  /** The model's own id on that connection (`gpt-5.6-luna`). */
  model: string;
};

/**
 * Split a routed id. Only ids with a `/` are routes — every Claude Code and
 * Codex id is a bare model id and answers null, which is what lets one row
 * component serve all three drivers.
 */
export function routeOf(id: string): ModelRoute | null {
  const index = id.indexOf("/");
  if (index <= 0 || index === id.length - 1) return null;
  return { connection: id.slice(0, index), model: id.slice(index + 1) };
}

/** models.dev's own display names for the connections seen on this machine,
 *  plus the majors. Everything else goes through `titleCase`. */
const CONNECTION_NAMES: Record<string, string> = {
  openai: "OpenAI",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  google: "Google",
  "google-vertex": "Google Vertex",
  azure: "Azure",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  groq: "Groq",
};

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** What the picker calls a connection. */
export function connectionLabel(connection: string): string {
  return CONNECTION_NAMES[connection] ?? titleCase(connection);
}

/**
 * The words a search box should match a family against: the label, the raw
 * id(s) — which is what a person who read an OpenCode route somewhere will
 * paste — and the connection's display name, so "go" or "openai" narrows to a
 * connection. Lower-cased once here so the filter does not re-lower per key.
 */
export function familySearchText(family: { label: string; id: string; rows: readonly { id: string }[] }): string {
  const route = routeOf(family.id);
  return [family.label, family.id, ...family.rows.map((row) => row.id), ...(route ? [connectionLabel(route.connection), route.connection] : [])]
    .join("\n")
    .toLowerCase();
}

/**
 * A routed family's readable name: the MODEL half, prettified the way
 * models.dev writes it ("gpt-5.6-luna" → "GPT-5.6 Luna" is the name OpenCode's
 * own UI shows for both routes of it). Heuristic, stated as one: known
 * alphabet-soup prefixes are upper-cased, other words title-cased, and the id
 * is always still visible to a hover/tooltip because the row keeps it.
 */
const ACRONYMS = new Set(["gpt", "glm", "hy", "xai", "llm"]);

export function routedModelLabel(model: string): string {
  return model
    .split("-")
    .filter(Boolean)
    .map((part) => (ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/^(\S+) (\d)/, "$1-$2"); // "GPT 5.6 Luna" → "GPT-5.6 Luna", models.dev's spelling
}
