// ONE TOOL DEFINITION, TWO HARNESSES — the conversion layer.
//
// Telar's own tools (ultra, loom, workspace) are written once, with the Agent
// SDK's `tool(name, description, zodShape, handler)` helper. That helper
// returns a plain `{name, description, inputSchema, handler}` record, which is
// structurally the core port's `HarnessToolDescriptor` — so the SAME array
// feeds both harnesses and no handler is written twice:
//
//   · Claude — `createSdkMcpServer({tools})`, exactly as before. Unchanged.
//   · Codex  — `dynamicTools` on thread/start, where each tool is
//     `{name, description, inputSchema}` with inputSchema as JSON SCHEMA, and
//     the server calls back with a `dynamicToolCall` request the adapter
//     answers in-process.
//
// The only real work is the schema direction: zod raw shape → JSON Schema.
// zod v4 does that natively (`z.toJSONSchema`), which is why the descriptor
// carries the zod shape rather than JSON Schema — zod is the richer source and
// the reverse conversion would be lossy.
//
// WHY NOT AN HTTP MCP SERVER. Codex 0.145 does support streamable-HTTP MCP
// servers (`codex mcp add --url`), and that was the obvious first design: serve
// Telar's tools from a Next route, point Codex at localhost with a bearer
// token. Dynamic tools are strictly better here — no second listening socket,
// no token to mint/rotate/leak, no entry written into the user's global
// ~/.codex/config.toml, and the tools keep running in the SAME process that
// owns the ultra run registry and the loom store, which is the only place they
// can see live in-process state at all. An out-of-process MCP server would
// have had to re-reach that state over yet another hop.
import { z } from "zod";
import type { HarnessToolDescriptor, HarnessToolNamespace, HarnessToolResult } from "@telar/core";

/** A Codex `DynamicToolFunctionSpec` — generated-schema shape, transcribed
 *  rather than imported: the generated types live outside the repo (emitted by
 *  `codex app-server generate-ts --experimental`) and pinning a copy here is
 *  what the research calls for, so a harness version bump surfaces as a type
 *  error in one place instead of a runtime mismatch in three. */
export type DynamicToolFunctionSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

export type DynamicToolNamespaceSpec = {
  name: string;
  description: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
};

export type DynamicToolSpec =
  | ({ type: "function" } & DynamicToolFunctionSpec)
  | ({ type: "namespace" } & DynamicToolNamespaceSpec);

/** zod raw shape → JSON Schema, the one direction that needs doing.
 *
 *  `io: "input"` matters: a schema with defaults or transforms describes a
 *  DIFFERENT type on the way in than on the way out, and what a tool caller
 *  must satisfy is the input side. Getting this wrong would advertise required
 *  fields the tool actually defaults. */
export function shapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): unknown {
  return z.toJSONSchema(z.object(shape), { io: "input" });
}

/** Namespaced, because both harnesses namespace and the names must line up:
 *  Claude surfaces these as `mcp__ultra__ultra`, Codex as namespace `ultra`
 *  holding tool `ultra`. Same tool, same identity, two spellings. */
export function toDynamicToolSpec(ns: HarnessToolNamespace): DynamicToolSpec {
  return {
    type: "namespace",
    name: ns.name,
    description: `Telar ${ns.name} tools.`,
    tools: ns.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeToJsonSchema(t.inputSchema),
    })),
  };
}

/** Flatten every namespace into the `dynamicTools` array thread/start takes. */
export function toDynamicTools(namespaces: readonly HarnessToolNamespace[]): DynamicToolSpec[] {
  return namespaces.map(toDynamicToolSpec);
}

/** Find the handler for a `dynamicToolCall`. Codex sends `{namespace, tool}`,
 *  with `namespace` null for a flat function tool — both are resolved here so
 *  the adapter never has to know how the tools were grouped.
 *
 *  Returns null when nothing matches, which the adapter must report as a tool
 *  ERROR rather than throwing: a model asking for a tool that does not exist is
 *  a normal thing to answer, not a reason to end the turn. */
export function findTool(
  namespaces: readonly HarnessToolNamespace[],
  namespace: string | null,
  tool: string,
): HarnessToolDescriptor | null {
  for (const ns of namespaces) {
    if (namespace != null && ns.name !== namespace) continue;
    const found = ns.tools.find((t) => t.name === tool);
    if (found) return found;
  }
  return null;
}

/** The ONE name for a tool, in the spelling the rest of Telar uses.
 *
 *  Claude surfaces an in-process MCP tool as `mcp__loom__start_loom`; Codex
 *  calls the same thing `{namespace: "loom", tool: "start_loom"}`. Every
 *  policy constant in the repo — LOOM_START_TOOL, LOOM_AUTO_TOOLS, a project's
 *  guardrails.disallowedTools, a profile's toolPolicy.deny — is written in the
 *  first spelling, so the Codex adapter translates INTO it before asking any
 *  policy question. Doing that conversion here rather than at the comparison
 *  keeps "which tool is this" from having two answers. */
export function qualifiedToolName(namespace: string | null, tool: string): string {
  return namespace ? `mcp__${namespace}__${tool}` : tool;
}

/** A tool result → the `contentItems` a DynamicToolCallResponse carries.
 *
 *  Non-text content is DROPPED WITH A NOTE rather than silently: Telar's tools
 *  return text today, and a future image result quietly vanishing would be a
 *  much worse failure than one that says what it did. */
export function toContentItems(result: HarnessToolResult): Array<{ type: "inputText"; text: string }> {
  return result.content.map((c) =>
    c.type === "text" && typeof c.text === "string"
      ? { type: "inputText" as const, text: c.text }
      : { type: "inputText" as const, text: `[${c.type} content omitted — Telar returns text only]` },
  );
}

/** Build a namespace from an SDK-built tool array. The cast is the one place
 *  the structural identity between `SdkMcpToolDefinition` and
 *  `HarnessToolDescriptor` is asserted; it is safe because the SDK's `tool()`
 *  produces exactly `{name, description, inputSchema, handler}` (verified
 *  against sdk.d.ts's SdkMcpToolDefinition), and it is CONFINED to this
 *  function so nothing else has to know. */
export function namespaceOf(
  name: string,
  version: string,
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown; handler: unknown }>,
): HarnessToolNamespace {
  return { name, version, tools: tools as unknown as readonly HarnessToolDescriptor[] };
}
