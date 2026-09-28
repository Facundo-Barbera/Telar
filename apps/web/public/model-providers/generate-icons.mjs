// One-shot generator: embeds the vendored marks into
// src/features/providers/components/connection-icon.tsx. Kept beside the SVGs so re-vendoring
// a logo regenerates the component instead of hand-editing path data.
//
// TWO KINDS OF MARK, AND THE DIFFERENCE IS THE POINT (issue #655). `MARKS` is
// keyed by models.dev CONNECTION id — `opencode` there is OpenCode ZEN, one
// account type, and its logo is a blocky Z. `OPENCODE_MARK` is the OpenCode
// APPLICATION's own mark, vendored from opencode's brand assets rather than
// models.dev, because models.dev has no entry for the app itself. Using the
// first where the second belongs is what told people their Bedrock-routed
// model was a Zen model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Every `<path>` in the file, so a two-tone mark survives vendoring. The plain
 *  one is the mark; one carrying `opacity` is its dimmer second tone. */
const read = (name) => {
  const svg = fs.readFileSync(path.join(here, `${name}.svg`), "utf8");
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((match) => match[0]);
  const dOf = (tag) => /\bd="([^"]+)"/.exec(tag)[1];
  const dim = paths.find((tag) => /\bopacity="/.test(tag));
  const solid = paths.find((tag) => !/\bopacity="/.test(tag));
  return {
    viewBox: /viewBox="([^"]+)"/.exec(svg)[1],
    d: dOf(solid),
    ...(dim ? { dim: dOf(dim), dimOpacity: Number(/\bopacity="([^"]+)"/.exec(dim)[1]) } : {}),
  };
};
const marks = {
  openai: read("openai"),
  anthropic: read("anthropic"),
  opencode: read("opencode"),
  "opencode-go": read("opencode-go"),
  "amazon-bedrock": read("amazon-bedrock"),
};
const openCodeMark = read("opencode-app");

const out = `import { cn } from "@/ui/utils";
import { routeOf } from "../model-connections";
import type { ProviderDriverKind } from "@telar/engine-client";

// Connection marks are models.dev provider logos (MIT, github.com/sst/models.dev); OPENCODE_MARK is from
// opencode's brand assets (MIT, github.com/anomalyco/opencode). Originals and ATTRIBUTION.md: public/model-providers/.

/** \`dim\` is a second path a two-tone mark is drawn in — kept as its own field
 *  so vendoring one never silently flattens it to a single shape. */
export type Mark = { viewBox: string; d: string; dim?: string; dimOpacity?: number };

const MARKS: Record<string, Mark> = ${JSON.stringify(marks, null, 2)};

/**
 * The OpenCode APPLICATION's mark — the provider, not an account under it.
 *
 * Deliberately NOT in \`MARKS\`: that map is keyed by models.dev connection id,
 * and \`opencode\` there is already taken, correctly, by OpenCode Zen.
 */
export const OPENCODE_MARK: Mark = ${JSON.stringify(openCodeMark, null, 2)};

/**
 * Connections that genuinely share another's mark.
 *
 * \`opencode-go\` USED TO BE HERE, aliased to \`opencode\` on the reasoning that
 * "OpenCode gateway connections share OpenCode's own mark". Both halves were
 * wrong: models.dev publishes Go its own mark, and the one it was borrowing was
 * Zen's rather than OpenCode's (#655).
 */
const ALIASES: Record<string, string> = { "bedrock-mantle": "amazon-bedrock" };

export function connectionMark(connection: string): Mark | undefined {
  return MARKS[connection] ?? MARKS[ALIASES[connection] ?? ""];
}

/** One mark, at the size asked for. The shared renderer for both kinds. */
export function MarkIcon({ mark, size = 14, className }: { mark: Mark; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill="currentColor"
      shapeRendering="geometricPrecision"
      className={className}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {mark.dim && <path d={mark.dim} opacity={mark.dimOpacity ?? 0.45} />}
      <path d={mark.d} />
    </svg>
  );
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
  return <MarkIcon mark={mark} size={size} className={className} />;
}

/**
 * The mark a MODEL ROW carries, on every driver: a routed OpenCode id shows
 * its connection's mark, a Claude Code row shows Anthropic's, a Codex row
 * OpenAI's — so "who serves this model" reads the same way in all three
 * lists.
 *
 * THE UNROUTED FALLBACK IS THE PROVIDER'S MARK, not a connection's. An
 * OpenCode id with no \`provider/\` in front of it (a manually added one) says
 * nothing about which account serves it, so it gets OpenCode's own mark rather
 * than a guess that would have read as Zen.
 */
export function ModelRowIcon({ driver, modelId, size = 14, className }: { driver: ProviderDriverKind; modelId: string; size?: number; className?: string }) {
  const route = routeOf(modelId);
  if (route) return <ConnectionIcon connection={route.connection} size={size} className={className} />;
  if (driver === "opencode") return <MarkIcon mark={OPENCODE_MARK} size={size} className={className} />;
  return <ConnectionIcon connection={driver === "claude" ? "anthropic" : "openai"} size={size} className={className} />;
}
`;
fs.writeFileSync(path.join(here, "..", "..", "src", "features", "providers", "components", "connection-icon.tsx"), out);
console.log(`connection-icon.tsx written (${out.length} bytes)`);
