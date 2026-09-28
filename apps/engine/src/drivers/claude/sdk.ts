import fs from "node:fs";
import type { McpServer, NotificationDetail, TurnAttachment } from "@telar/engine-client";
import { claudeFixedWindowOf } from "../../domains/providers";
import type { RunCapability } from "../../domains/terminal";
import type { DisplayCapability } from "../../domains/agent-tools";
import { RELAY_RULE } from "../../domains/turns";
import type { SessionsCapability } from "../../domains/sessions";
import type { NotesCapability } from "../../domains/notes";
import type { PromptsCapability } from "../../domains/prompts";

/** The SDK's permission callback, narrowed to what this driver uses. */
export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; title?: string },
) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean }>;

type SdkMcpServer = unknown;

export type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string | Array<Record<string, unknown>> };
  parent_tool_use_id: null;
  /** The send's join key — echoed back as `user_message_uuid` on the reply
   *  it triggers. See `FeedMessage.uuid` in ./claude-runtime.ts. */
  uuid?: string;
  /** Present only when a PERSON typed this message — see `FeedMessage.origin`
   *  in ./claude-runtime.ts for why `human` is the only kind that lands. */
  origin?: { kind: "human" };
};

/** The image types the Anthropic API accepts as an image block. Anything else
 *  is offered as a PATH instead — the agent has a Read tool, and a file it can
 *  open beats a block the API rejects. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function claudeInitialContent(prompt: string, attachments: TurnAttachment[]): string | Array<Record<string, unknown>> {
  if (attachments.length === 0) return prompt;
  const blocks: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const attachment of attachments) {
    if (CLAUDE_IMAGE_TYPES.has(attachment.mediaType)) {
      try {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mediaType, data: fs.readFileSync(attachment.path).toString("base64") },
        });
        notes.push(`- ${attachment.name} (image, shown above)`);
        continue;
      } catch {
        notes.push(`- ${attachment.name} — attached but could not be read from ${attachment.path}`);
        continue;
      }
    }
    notes.push(`- ${attachment.name} (${attachment.mediaType}) at ${attachment.path}`);
  }
  // An image-only message still carries this block, so the model is never
  // handed pixels with no words at all — the note is the "look at this".
  blocks.push({ type: "text", text: `${prompt.trim() ? `${prompt}\n\n` : ""}Attached files:\n${notes.join("\n")}` });
  return blocks;
}

export function claudeNotificationOrigin(detail: NotificationDetail): { kind: string; [field: string]: unknown } {
  if (detail.kind === "peer_message") {
    const from = detail.sessionId ?? "sessions-socket";
    return { kind: "peer", from, ...(detail.sessionId ? { fromSession: detail.sessionId } : {}) };
  }
  // A wake and a parked request are the ENGINE reporting a background
  // happening, which is exactly what this kind means to the CLI — and it is the
  // one that gets framed as a notification rather than as prompt authority.
  return { kind: "task-notification" };
}

export function claudeNotificationContent(body: string, detail?: NotificationDetail): string {
  const rule = detail?.kind === "peer_message" ? `\n${RELAY_RULE}` : "";
  return `<system-reminder>\n${body}${rule}\n</system-reminder>`;
}

/** The field kill switch: `TELAR_CLAUDE_STREAMING_INPUT=0` restores the
 *  plain-string prompt (and with it, no send-now on Claude). */
export function claudeStreamingInputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELAR_CLAUDE_STREAMING_INPUT?.trim() !== "0";
}

/** One user message and the stream closes: the kill-switch turn with
 *  attachments still needs the block form, and nothing else does. The
 *  streaming path's input is the session runtime's own MessageFeed. */
export async function* singleUserMessage(content: string | Array<Record<string, unknown>>): AsyncGenerator<SdkUserMessage> {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export type ClaudeTurnBindings = {
  signal: AbortSignal;
  canUseTool: SdkCanUseTool | undefined;
  sessions: SessionsCapability | undefined;
  /** The project's notebook, scoped to this turn's project. */
  notes: NotesCapability | undefined;
  /** The project's prompt shelf, scoped to this turn's project AND session. */
  prompts: PromptsCapability | undefined;
  display: DisplayCapability | undefined;
  /** The project's runs, when the turn carries them. See `run/capability.ts`. */
  run: RunCapability | undefined;
  /** Every enabled plugin's capability, by id — Data Science and LaTeX included. */
  plugins: Record<string, unknown> | undefined;
};

export function claudeMcpServers(servers: McpServer[] | undefined): Record<string, SdkMcpServer> | undefined {
  if (!servers || servers.length === 0) return undefined;
  const out: Record<string, SdkMcpServer> = {};
  for (const server of servers) {
    if (server.spec.transport === "stdio") {
      out[server.id] = {
        type: "stdio",
        command: server.spec.command,
        ...(server.spec.args ? { args: server.spec.args } : {}),
        // Overlaid on the worker's environment rather than replacing it: an MCP
        // server still needs PATH and HOME like any other child process.
        ...(server.spec.env ? { env: { ...process.env, ...server.spec.env } } : {}),
      };
      continue;
    }
    out[server.id] = {
      type: server.spec.transport,
      url: server.spec.url,
      ...(server.spec.headers ? { headers: server.spec.headers } : {}),
    };
  }
  return out;
}

const CLAUDE_1M_FAMILY_ALIAS = /^(opus|sonnet|fable)(?:$|[-[])/i;

function isClaudeLongContextFamily(model: string): boolean {
  return /(^|[/])claude-(?:opus|sonnet|fable)-/i.test(model) || CLAUDE_1M_FAMILY_ALIAS.test(model);
}

export function claudeContextEnvForModel(model: string | undefined): Record<string, string> | undefined {
  if (model && !isClaudeLongContextFamily(model)) return undefined;
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" };
}

export function claudeToolSearchEnv(base: Record<string, string | undefined>): Record<string, string> | undefined {
  return base.ENABLE_TOOL_SEARCH === undefined ? { ENABLE_TOOL_SEARCH: "true" } : undefined;
}

export const SESSION_STATE_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" };

/** The window a Claude id SPELLS — `[1m]` or not. Absent means the provider's
 *  default, which is its own and not this driver's to guess. */
export function claudeWindowOf(model: string | undefined): "long" | "default" {
  return model && /\[1m\]$/i.test(model) ? "long" : "default";
}

export function selectedContextMaxFromModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  // A fixed-window model (Opus 4.8 / 4.7) has no choice to guess at.
  return /\[1m\]$/i.test(model) && isClaudeLongContextFamily(model) ? 1_000_000 : claudeFixedWindowOf(model);
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
export const claudeEffort = (value: string | undefined): ClaudeEffort | undefined =>
  value !== undefined && CLAUDE_EFFORTS.has(value) ? (value as ClaudeEffort) : undefined;

export type ClaudeSdk = {
  query(input: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options: {
      cwd: string;
      permissionMode: "default";
      systemPrompt?: { type: "preset"; preset: "claude_code"; append: string };
      abortController: AbortController;
      /** Omitted entirely when the session names none — the SDK then uses the
       *  model the local Claude Code install is configured with. */
      model?: string;
      settings?: { fastMode?: boolean; ultracode?: boolean };
      /** How hard to think. A CLOSED vocabulary here, unlike `DriverRun.effort`
       *  — see `claudeEffort` below. */
      effort?: ClaudeEffort;
      includePartialMessages: true;
      /** Without this the SDK forwards only a sub-agent's tool_use/tool_result
       *  blocks — "enough for a heartbeat counter", in its own words. A nested
       *  transcript needs the text and the thinking too. */
      forwardSubagentText: true;
      perTaskStopAffordance?: boolean;
      resume?: string;
      canUseTool?: SdkCanUseTool;
      mcpServers?: Record<string, SdkMcpServer>;
      env?: Record<string, string | undefined>;
      pathToClaudeCodeExecutable?: string;
    };
  }): AsyncIterable<unknown>;
  /** OPTIONAL because the fake SDKs the tests inject only implement `query`.
   *  A driver whose SDK lacks these simply gets no browser tools. */
  createSdkMcpServer?(input: { name: string; version: string; tools: unknown[] }): SdkMcpServer;
  tool?(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ): unknown;
};
