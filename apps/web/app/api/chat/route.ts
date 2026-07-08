import { query } from "@anthropic-ai/claude-agent-sdk";
import { accountEnv } from "@telar/core";
import path from "path";
import { ACCOUNTS } from "@/lib/accounts";

// Each POST = one turn. Continuation happens via `resume: sessionId` —
// the SDK restores the full conversation from the session transcript.
export async function POST(req: Request) {
  const {
    message,
    sessionId,
    model = "sonnet",
    account = "personal",
  } = await req.json();

  const profile = ACCOUNTS[account] ?? ACCOUNTS.personal;
  const workspace =
    process.env.TELAR_WORKSPACE ?? path.resolve(process.cwd(), "../..");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      try {
        for await (const msg of query({
          prompt: message,
          options: {
            cwd: workspace,
            ...(sessionId ? { resume: sessionId } : {}),
            model,
            env: accountEnv(profile),
            systemPrompt: { type: "preset", preset: "claude_code" },
            permissionMode: "default",
            allowedTools: ["Read", "Grep", "Glob"],
            maxTurns: 25,
          },
        })) {
          if (msg.type === "system" && msg.subtype === "init") {
            send("session", {
              sessionId: (msg as { session_id: string }).session_id,
            });
          } else if (msg.type === "assistant") {
            const content =
              (msg as { message?: { content?: Array<Record<string, unknown>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type === "text") send("text", { text: block.text });
              if (block.type === "tool_use") send("tool", { name: block.name });
            }
          } else if (msg.type === "result") {
            const r = msg as unknown as {
              subtype: string;
              total_cost_usd?: number;
              num_turns?: number;
            };
            send("done", {
              subtype: r.subtype,
              costUsd: r.total_cost_usd,
              turns: r.num_turns,
            });
          }
        }
      } catch (e) {
        send("error", { message: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
