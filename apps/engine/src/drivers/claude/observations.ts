import type { ItemDetail, ItemSeed, TurnObservation } from "@telar/engine-client";
import { countDiffLines, patchHunksOf, unifiedDiff } from "../../domains/git";
import { asRecord, str, isFileTool, pathFromPartialInput, itemDetailForToolCall, titleForToolCall } from "./mapping";

/** A streamed text or thinking block between its start and stop. */
export type OpenBlock = {
  id: string;
  kind: "text" | "thinking";
  text: string;
  /** The task the row is filed under, repeated on every update — an
   *  `item.updated` replaces the whole stored item. */
  taskId?: string;
  /** Thinking only: the provider's running size estimate, and the last value
   *  actually reported (see `THINKING_TOKEN_STEP`). */
  estimatedTokens?: number;
  reportedTokens?: number;
};

const THINKING_TOKEN_STEP = 500;

export function reasoningDetail(block: OpenBlock): ItemDetail {
  return {
    type: "reasoning",
    text: block.text,
    ...(block.estimatedTokens === undefined ? {} : { estimatedTokens: block.estimatedTokens }),
  };
}

export function noteThinkingTokens(block: OpenBlock, tokens: unknown): TurnObservation | undefined {
  if (block.kind !== "thinking" || typeof tokens !== "number" || !Number.isFinite(tokens)) return undefined;
  const rounded = Math.floor(tokens);
  if (rounded <= (block.estimatedTokens ?? 0)) return undefined;
  block.estimatedTokens = rounded;
  if (Math.floor(rounded / THINKING_TOKEN_STEP) <= Math.floor((block.reportedTokens ?? 0) / THINKING_TOKEN_STEP)) return undefined;
  block.reportedTokens = rounded;
  return {
    kind: "item.updated",
    item: { id: block.id, detail: reasoningDetail(block), ...(block.taskId ? { taskId: block.taskId } : {}) },
  };
}

export function streamingToolSeed(useId: string, name: string, ownerTaskId: string | undefined): ItemSeed {
  const isTask = name === "Task" || name === "Agent";
  const detail: ItemDetail = isTask ? { type: "task", taskId: `task_${useId}` } : itemDetailForToolCall(name, {});
  return {
    id: `item_${useId}`,
    detail,
    title: isTask ? name : titleForToolCall(name, detail),
    ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
    providerRefs: { itemId: useId },
  };
}

/** A file tool's input while it streams, keyed like a text block by owner and
 *  index — `input_json_delta` names the index, not the call. */
export type StreamingInput = { useId: string; name: string; json: string; taskId?: string };

export function streamingInputFor(useId: string, name: string, ownerTaskId: string | undefined): StreamingInput | undefined {
  return isFileTool(name) ? { useId, name, json: "", ...(ownerTaskId ? { taskId: ownerTaskId } : {}) } : undefined;
}

export function streamedPathUpdate(
  inputs: Map<string, StreamingInput>,
  tools: Map<string, { id: string; detail: ItemDetail }>,
  index: string,
  delta: unknown,
): TurnObservation | undefined {
  const input = inputs.get(index);
  const fragment = asRecord(delta);
  if (!input || fragment.type !== "input_json_delta" || typeof fragment.partial_json !== "string") return undefined;
  input.json += fragment.partial_json;
  const path = pathFromPartialInput(input.json);
  if (!path) return undefined;
  inputs.delete(index);
  const open = tools.get(input.useId);
  if (!open) return undefined;
  const detail = itemDetailForToolCall(input.name, { file_path: path });
  tools.set(input.useId, { id: open.id, detail });
  return {
    kind: "item.updated",
    item: {
      id: open.id,
      detail,
      title: titleForToolCall(input.name, detail),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      providerRefs: { itemId: input.useId },
    },
  };
}

/** The newest open thinking block of one owner — what `system/thinking_tokens`,
 *  which names no block index, is about. */
export function openThinkingOf(blocks: Map<string, OpenBlock>, owner: string | undefined): OpenBlock | undefined {
  const prefix = `${owner ?? ""}#`;
  let found: OpenBlock | undefined;
  for (const [key, block] of blocks) if (block.kind === "thinking" && key.startsWith(prefix)) found = block;
  return found;
}

/** The plain text of a user message's content — the CLI's own injected
 *  notification, when it wakes the model. */
export function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map(asRecord).filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n");
  return text.length > 0 ? text : undefined;
}

export function withToolResult(detail: ItemDetail, output: string, structured?: unknown): ItemDetail {
  if (detail.type === "file_change") {
    const hunks = patchHunksOf(structured);
    if (!hunks) return detail;
    const { diff, truncated } = unifiedDiff(detail.change.path, hunks);
    return {
      ...detail,
      change: {
        ...detail.change,
        unifiedDiff: diff,
        // Set only when it is true — absent reads as "nobody said", which is
        // what an older engine's answer means (#694, §2.5).
        ...(truncated ? { diffTruncated: true } : {}),
        // COUNTED FROM THE HUNKS, so a truncated diff still reports the whole
        // change's ± figures: the bound is on what is CARRIED, not on what
        // happened.
        ...countDiffLines(hunks),
      },
    };
  }
  return withToolOutput(detail, output);
}

function withToolOutput(detail: ItemDetail, output: string): ItemDetail {
  const preview = output.length > 4_000 ? `${output.slice(0, 4_000)}…` : output;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: preview } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    // A browser action's output is its snapshot or its console dump, and it is
    // the whole reason the row is expandable. Omitted before this arm existed.
    case "browser_action":
      return { ...detail, call: { ...detail.call, output: preview } };
    default:
      return detail;
  }
}
