/**
 * THE TOOL ADAPTER — Telar's `ToolFactory` seam, answered with LangChain.
 *
 * `sessionsTools(tool, capability)` and `notesTools(tool, capability)` take the
 * factory as an ARGUMENT precisely so the provider SDK never has to be imported
 * beside them. That seam is what this file spends: it hands them a `tool` that
 * returns a LangChain `StructuredTool`, and neither wall knows or cares.
 *
 * ── WHAT A WALL HANDS OVER, AND WHAT LANGCHAIN WANTS ────────────────────────
 * The wall's `shape` is a plain object of zod schemas (the MCP convention);
 * LangChain's `tool()` wants ONE schema. `z.object(shape)` is the whole
 * conversion — no field is renamed, no description is dropped, and the
 * `.describe()` text the wall wrote is what reaches the model.
 *
 * The wall's handler returns MCP content (`{ content: [{ type: "text", text }],
 * isError? }`). A LangChain tool returns a string. `flatten` joins the text
 * parts, and an `isError: true` answer is returned as text rather than thrown —
 * a refusal from these walls is a SENTENCE the model is meant to read and act
 * on ("that note is the user's", "name the project"), and throwing it would
 * turn a designed refusal into a framework-level tool failure.
 *
 * ── TWO COPIES OF ZOD ───────────────────────────────────────────────────────
 * The walls import the workspace's zod; this package installs its own at the
 * same version. `z.object()` from one copy wrapping field schemas from another
 * works because zod v4 schemas carry their own `~standard` validator and
 * LangChain reads them through that interface rather than by `instanceof`.
 * `test/adapter.test.ts` asserts it rather than trusting it.
 */
import { tool as langchainTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ToolFactory } from "../../../../apps/engine/src/tool-kit";
import type { Meter } from "./meter";

type McpAnswer = { content: unknown[]; isError?: boolean };

/** The text parts of an MCP answer, joined. Anything that is not a text part
 *  is reported rather than silently dropped — a tool wall that grew an image
 *  part should show up as a question, not as an empty answer. */
export function flatten(answer: McpAnswer): string {
  const parts: string[] = [];
  for (const item of answer.content) {
    if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
      parts.push(String((item as { text?: unknown }).text ?? ""));
    } else {
      parts.push(`[non-text tool content: ${JSON.stringify(item)}]`);
    }
  }
  return parts.join("\n");
}

export type AdapterOptions = {
  /** Counts every call. Optional so a wall can be built for inspection only. */
  meter?: Meter;
  /** Called before the handler runs — the seam scenario 6 hangs its
   *  before-the-effect ledger on, and where a real integration would put a
   *  permission check that is not the model's to make. */
  onCall?: (name: string, args: Record<string, unknown>) => void;
};

/**
 * A `ToolFactory` that mints LangChain tools.
 *
 * Returns the factory and the list it filled, because `sessionsTools` returns
 * `unknown[]` by design (it must not name the SDK's type) and the caller needs
 * the typed list back.
 */
export function langchainToolFactory(options: AdapterOptions = {}): {
  factory: ToolFactory;
  tools: StructuredToolInterface[];
} {
  const tools: StructuredToolInterface[] = [];
  const factory: ToolFactory = (name, description, shape, handler) => {
    const schema = z.object(shape as Record<string, z.ZodTypeAny>);
    const built = langchainTool(
      async (args: Record<string, unknown>) => {
        options.meter?.recordToolCall(name);
        options.onCall?.(name, args ?? {});
        const answer = await handler(args ?? {});
        return flatten(answer);
      },
      { name, description, schema },
    ) as unknown as StructuredToolInterface;
    tools.push(built);
    return built;
  };
  return { factory, tools };
}

/** Build both walls over one meter. The order is the order a model sees them
 *  in, and sessions first is deliberate: it is the wall the Agent is for. */
export function buildToolWalls(
  build: Array<(factory: ToolFactory) => unknown[]>,
  options: AdapterOptions = {},
): StructuredToolInterface[] {
  const { factory, tools } = langchainToolFactory(options);
  for (const one of build) one(factory);
  return tools;
}
