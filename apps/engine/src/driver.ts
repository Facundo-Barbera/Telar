/**
 * Provider code is deliberately a leaf of vNext.  It receives an AbortSignal
 * and can only report text/final output; it cannot mutate project or session
 * state.  The worker returns those observations to the engine, which owns the
 * durable journal and terminal transition.
 */
export type DriverRun = {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** Engine-owned Claude continuity token from the preceding completed turn. */
  providerSessionId?: string;
  onText(text: string): Promise<void>;
};

export type TurnDriver = {
  run(input: DriverRun): Promise<{ text: string; providerSessionId?: string }>;
};

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

type ClaudeSdk = {
  query(input: {
    prompt: string;
    options: {
      cwd: string;
      permissionMode: "default";
      abortController: AbortController;
      includePartialMessages: true;
      resume?: string;
    };
  }): AsyncIterable<unknown>;
};

/**
 * Thin, injectable bridge to the locally installed Agent SDK. It does not
 * import Telar's legacy route/core execution layer and leaves approvals at the
 * SDK's normal default. A missing SDK/login is surfaced as a failure, never a
 * fabricated answer.
 */
export function createClaudeDriver(loadSdk: () => Promise<ClaudeSdk> = () => import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeSdk>): TurnDriver {
  return {
    async run({ prompt, cwd, signal, onText, providerSessionId }) {
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        throw new ProviderUnavailableError("Claude Agent SDK is unavailable; install and configure Claude Code before retrying");
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      let finalText = "";
      let receivedPartialText = false;
      let reportedSessionId: string | undefined;
      let completed = false;
      try {
        for await (const message of sdk.query({
          prompt,
          options: {
            cwd,
            permissionMode: "default",
            abortController: controller,
            includePartialMessages: true,
            ...(providerSessionId ? { resume: providerSessionId } : {}),
          },
        })) {
          const item = message as {
            type?: string;
            subtype?: string;
            message?: { content?: Array<{ type?: string; text?: string }> };
            event?: { type?: string; delta?: { type?: string; text?: string } };
            session_id?: string;
          };
          if (typeof item.session_id === "string" && item.session_id) reportedSessionId = item.session_id;
          if (item.type === "result") {
            if (item.subtype !== "success") throw new Error(`Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`);
            completed = true;
            continue;
          }
          if (item.type === "stream_event" && item.event?.type === "content_block_delta" && item.event.delta?.type === "text_delta") {
            const text = item.event.delta.text;
            if (typeof text === "string" && text.length > 0) {
              receivedPartialText = true;
              finalText += text;
              await onText(text);
            }
            continue;
          }
          if (item.type !== "assistant") continue;
          // With partial messages enabled the final assistant envelope repeats
          // its content. Text emitted from it would double both the transcript
          // and final result, so it is only our compatibility fallback.
          if (receivedPartialText) continue;
          for (const block of item.message?.content ?? []) {
            if (block.type !== "text" || typeof block.text !== "string" || block.text.length === 0) continue;
            finalText += block.text;
            await onText(block.text);
          }
        }
        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        if (!completed) throw new Error("Claude ended without a successful result");
        return { text: finalText, ...(reportedSessionId ? { providerSessionId: reportedSessionId } : {}) };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
