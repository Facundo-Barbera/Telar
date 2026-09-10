// One-shot generator: embeds the vendored models.dev marks into
// components/session/connection-icon.tsx. Kept beside the SVGs so re-vendoring
// a logo regenerates the component instead of hand-editing path data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => {
  const svg = fs.readFileSync(path.join(here, `${name}.svg`), "utf8");
  return { viewBox: /viewBox="([^"]+)"/.exec(svg)[1], d: /<path[^>]*d="([^"]+)"/.exec(svg)[1] };
};
const marks = { openai: read("openai"), anthropic: read("anthropic"), opencode: read("opencode"), "amazon-bedrock": read("amazon-bedrock") };

const out = `/**
 * CONNECTION AND MODEL-PROVIDER MARKS for the model picker.
 *
 * The SVGs are models.dev provider logos (MIT, github.com/sst/models.dev) —
 * the same database and artwork OpenCode resolves its connections against,
 * vendored so the picker names a route with the mark OpenCode itself shows.
 * The originals as fetched live in public/model-providers/ beside
 * ATTRIBUTION.md; regenerate this file with generate-icons.mjs there. Every
 * path is fill=currentColor upstream, which is what lets one mark read in
 * both themes. An unknown connection gets a neutral monogram, never a wrong
 * logo.
 */
import { cn } from "@/lib/utils";
import { routeOf } from "@/lib/model-connections";
import type { ProviderDriverKind } from "@telar/engine-client";

type Mark = { viewBox: string; d: string };

const MARKS: Record<string, Mark> = ${JSON.stringify(marks, null, 2)};

/** OpenCode gateway connections share OpenCode's own mark; Mantle is Bedrock's. */
const ALIASES: Record<string, string> = { "opencode-go": "opencode", "bedrock-mantle": "amazon-bedrock" };

export function connectionMark(connection: string): Mark | undefined {
  return MARKS[connection] ?? MARKS[ALIASES[connection] ?? ""];
}

/** The mark for one connection id (\`openai\`, \`opencode-go\`), or a neutral
 *  monogram for one models.dev has no logo for. */
export function ConnectionIcon({ connection, size = 14, className }: { connection: string; size?: number; className?: string }) {
  const mark = connectionMark(connection);
  if (!mark) {
    return (
      <span
        aria-hidden
        className={cn("inline-flex items-center justify-center rounded-sm border font-mono text-[0.5rem] uppercase", className)}
        style={{ width: size, height: size }}
      >
        {connection.slice(0, 2)}
      </span>
    );
  }
  return (
    <svg width={size} height={size} viewBox={mark.viewBox} fill="currentColor" className={className} aria-hidden>
      <path d={mark.d} />
    </svg>
  );
}

/**
 * The mark a MODEL ROW carries, on every driver: a routed OpenCode id shows
 * its connection's mark, a Claude Code row shows Anthropic's, a Codex row
 * OpenAI's — so "who serves this model" reads the same way in all three
 * lists.
 */
export function ModelRowIcon({ driver, modelId, size = 14, className }: { driver: ProviderDriverKind; modelId: string; size?: number; className?: string }) {
  const route = routeOf(modelId);
  if (route) return <ConnectionIcon connection={route.connection} size={size} className={className} />;
  return <ConnectionIcon connection={driver === "claude" ? "anthropic" : driver === "codex" ? "openai" : "opencode"} size={size} className={className} />;
}
`;
fs.writeFileSync(path.join(here, "..", "..", "components", "session", "connection-icon.tsx"), out);
console.log(`connection-icon.tsx written (${out.length} bytes)`);
