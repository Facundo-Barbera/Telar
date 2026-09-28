
export type ModelRoute = {
  connection: string;
  model: string;
};

export function routeOf(id: string): ModelRoute | null {
  const index = id.indexOf("/");
  if (index <= 0 || index === id.length - 1) return null;
  return { connection: id.slice(0, index), model: id.slice(index + 1) };
}

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

export function connectionLabel(connection: string): string {
  return CONNECTION_NAMES[connection] ?? titleCase(connection);
}

export function familySearchText(family: { label: string; id: string; rows: readonly { id: string }[] }): string {
  const route = routeOf(family.id);
  return [family.label, family.id, ...family.rows.map((row) => row.id), ...(route ? [connectionLabel(route.connection), route.connection] : [])]
    .join("\n")
    .toLowerCase();
}

const ACRONYMS = new Set(["gpt", "glm", "hy", "xai", "llm"]);

export function routedModelLabel(model: string): string {
  return model
    .split("-")
    .filter(Boolean)
    .map((part) => (ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/^(\S+) (\d)/, "$1-$2"); // "GPT 5.6 Luna" → "GPT-5.6 Luna", models.dev's spelling
}
