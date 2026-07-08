import {
  query,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { accountEnv, getProject, type ProjectManifest } from "@telar/core";
import { ACCOUNTS } from "@/lib/accounts";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  createPending,
  resolvePending,
  readRules,
  addRule,
  ruleFor,
  ruleMatches,
  isProtectedPath,
  bashTouchesProtectedPath,
  inputPaths,
  type PermissionDecision,
} from "@/lib/permissions";
import {
  appendTurn,
  logUsage,
  savePlanUsage,
  type Part,
  type PlanSnapshot,
} from "@/lib/store";

const toIso = (epoch?: number) =>
  epoch ? new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString() : null;

// One POST = one turn. Continuation via `resume: sessionId`; the SDK restores
// full conversation state from the session transcript. Token-level streaming
// via includePartialMessages; client abort propagates to the subprocess.
export async function POST(req: Request) {
  const {
    message,
    sessionId,
    model = DEFAULT_MODEL,
    project,
  } = await req.json();

  // Resolve the anchoring project up front — an unknown/missing project is a
  // plain 400, not an SSE error, so the client fails before any stream opens.
  let manifest: ProjectManifest;
  try {
    manifest = getProject(project).manifest;
  } catch {
    return Response.json(
      { error: `Unknown project "${project ?? ""}".` },
      { status: 400 },
    );
  }

  const profile = ACCOUNTS[manifest.account] ?? ACCOUNTS.personal;
  const workspace = manifest.root;

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // client went away — keep consuming so we still persist the turn
        }
      };

      const parts: Part[] = [];
      let streamingText = ""; // text accumulated from deltas for current block
      let capturedSession = sessionId ?? null;
      let costUsd = 0;
      let usagePromise: Promise<any> | null = null;
      // Permission requests opened by THIS stream; drained (deny) on teardown so
      // a client disconnect never leaves canUseTool hanging or a pending leaked.
      const myPending = new Set<string>();

      // Interactive permissions, Claude Code-style: read tools are always
      // allowed; anything else asks the user through an SSE "permission"
      // event answered via POST /api/chat/permission. Guardrails hard-deny.
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        { signal, suggestions }: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
      ): Promise<PermissionResult> => {
        const g = manifest.guardrails;
        if (g.disallowedTools.includes(toolName)) {
          return { behavior: "deny", message: `${toolName} is disallowed by this project's guardrails.` };
        }
        const blocked = inputPaths(input).find((t) => isProtectedPath(workspace, g.protectedPaths, t));
        if (blocked) {
          return { behavior: "deny", message: `"${blocked}" is a protected path in this project.` };
        }
        // protectedPaths above only inspects path-shaped input keys, which
        // Bash never populates (its target lives in `command`) — check it
        // separately or the guardrail is a no-op for the most powerful tool.
        if (toolName === "Bash" && typeof input.command === "string" &&
            bashTouchesProtectedPath(workspace, g.protectedPaths, input.command)) {
          return { behavior: "deny", message: "This command touches a protected path in this project." };
        }
        const rule = ruleFor(toolName, input);
        if (readRules(project).some((r) => ruleMatches(r, toolName, input))) {
          return { behavior: "allow", updatedInput: input };
        }
        if (signal.aborted) return { behavior: "deny", message: "Aborted." };

        const { id, promise } = createPending(project, rule);
        myPending.add(id);
        // Respect the SDK's per-call signal: resolve the pending (deny) the
        // moment this tool call is aborted, rather than hanging to timeout.
        const onAbort = () => resolvePending(id, { behavior: "deny", reason: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        send("permission", { id, toolName, input, rule });

        let decision: PermissionDecision;
        try {
          decision = await promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
          myPending.delete(id);
        }

        send("permission_result", { id, behavior: decision.behavior });
        if (decision.behavior === "allow") {
          if (decision.always) addRule(project, rule);
          // Only forward suggestions that stay in-session — any other
          // destination (userSettings/projectSettings/localSettings) would
          // write a permission rule into a settings file telar never asked
          // to touch (and userSettings would land in the developer's own
          // ~/.claude/settings.json, which settingSources deliberately
          // excludes). Our own store (~/.telar/permissions.json) already
          // covers persistence.
          const sessionSuggestions = suggestions?.filter((s) => s.destination === "session");
          return {
            behavior: "allow",
            updatedInput: input,
            ...(decision.always && sessionSuggestions?.length
              ? { updatedPermissions: sessionSuggestions }
              : {}),
          };
        }
        // Distinguish a real user refusal from a timeout/abort so the model
        // doesn't treat silence as a deliberate "no" and abandon the tool.
        const message =
          decision.reason === "timeout"
            ? "No response from the user in time; treat as not yet decided."
            : decision.reason === "aborted"
              ? "The request was cancelled before the user responded."
              : "Denied by the user in telar.";
        return { behavior: "deny", message };
      };

      try {
        const q = query({
          prompt: message,
          options: {
            cwd: workspace,
            ...(capturedSession ? { resume: capturedSession } : {}),
            model,
            env: accountEnv(profile),
            systemPrompt: { type: "preset", preset: "claude_code" },
            permissionMode: "default",
            // Load the repo's own .claude: CLAUDE.md, skills, slash commands,
            // settings, hooks, and MCP servers. User-level settings stay out
            // on purpose (keeps the developer's personal config/tokens out of
            // the subprocess). This is a deliberate trust decision, not an
            // oversight: a repo's settings.local.json can itself grant
            // `permissions.allow`/`defaultMode: bypassPermissions`, which the
            // SDK honors BEFORE canUseTool is ever invoked — our guardrails
            // and the interactive prompt below are both bypassed for
            // whatever the repo pre-allows. Hooks/apiKeyHelper/MCP servers
            // from the repo's settings also run as ordinary subprocess code,
            // outside canUseTool entirely. `disallowedTools` is passed
            // explicitly below because the SDK guarantees a disallow always
            // wins over any allow rule (repo-settings or otherwise), which is
            // the one lever we have against a repo widening its own access.
            settingSources: ["project", "local"],
            allowedTools: ["Read", "Grep", "Glob"],
            disallowedTools: manifest.guardrails.disallowedTools,
            canUseTool,
            maxTurns: 25,
            includePartialMessages: true,
            abortController: abort,
          },
        });
        for await (const msg of q) {
          if (msg.type === "system" && msg.subtype === "init") {
            capturedSession = (msg as { session_id: string }).session_id;
            send("session", { sessionId: capturedSession });
            // Fire the plan-usage control call now — the subprocess must still
            // be alive when it resolves; awaiting it at result-time is too late.
            const usageFn = (q as unknown as Record<string, () => Promise<any>>)
              .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
            usagePromise = usageFn ? usageFn.call(q).catch(() => null) : null;
          } else if (msg.type === "stream_event") {
            const ev = (msg as { event: Record<string, any> }).event;
            if (ev?.type === "content_block_start") {
              if (ev.content_block?.type === "thinking") {
                send("thinking", {});
              }
              streamingText = "";
            } else if (
              ev?.type === "content_block_delta" &&
              ev.delta?.type === "text_delta"
            ) {
              streamingText += ev.delta.text;
              send("delta", { text: ev.delta.text });
            }
          } else if (msg.type === "assistant") {
            const content =
              (msg as { message?: { content?: Array<Record<string, any>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type === "text") {
                parts.push({ type: "text", text: block.text as string });
                send("text", { text: block.text }); // finalize the streamed block
                streamingText = "";
              }
              if (block.type === "tool_use") {
                parts.push({ type: "tool", name: block.name as string });
                send("tool", { name: block.name });
              }
            }
          } else if (msg.type === "rate_limit_event") {
            // Streamed mid-turn — single-window update, merge into the snapshot
            const info = (msg as { rate_limit_info?: Record<string, any> }).rate_limit_info;
            if (info?.rateLimitType && info.utilization != null) {
              const window = { utilization: info.utilization, resets_at: toIso(info.resetsAt) };
              const key =
                info.rateLimitType === "five_hour"
                  ? "fiveHour"
                  : info.rateLimitType === "seven_day"
                    ? "sevenDay"
                    : info.rateLimitType === "seven_day_opus"
                      ? "sevenDayOpus"
                      : info.rateLimitType === "seven_day_sonnet"
                        ? "sevenDaySonnet"
                        : null;
              if (key) {
                savePlanUsage(profile.name, { [key]: window });
                send("plan", { account: profile.name, [key]: window });
              }
            }
          } else if (msg.type === "result") {
            try {
              const u = usagePromise
                ? await Promise.race([
                    usagePromise,
                    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
                  ])
                : null;
              if (u?.rate_limits_available && u.rate_limits) {
                const rl = u.rate_limits;
                const snapshot: Partial<PlanSnapshot> = {
                  subscriptionType: u.subscription_type ?? null,
                  fiveHour: rl.five_hour ?? null,
                  sevenDay: rl.seven_day ?? null,
                  sevenDayOpus: rl.seven_day_opus ?? null,
                  sevenDaySonnet: rl.seven_day_sonnet ?? null,
                  modelScoped: rl.model_scoped ?? [],
                };
                savePlanUsage(profile.name, snapshot);
                send("plan", { account: profile.name, ...snapshot });
              }
            } catch {
              // experimental API — degrade silently, rate_limit_events still cover us
            }
            const r = msg as unknown as {
              subtype: string;
              total_cost_usd?: number;
              num_turns?: number;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
            costUsd = r.total_cost_usd ?? 0;
            if (capturedSession) {
              logUsage({
                ts: Date.now(),
                account: profile.name,
                model,
                sessionId: capturedSession,
                inputTokens: r.usage?.input_tokens ?? 0,
                outputTokens: r.usage?.output_tokens ?? 0,
                cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
                cacheCreateTokens: r.usage?.cache_creation_input_tokens ?? 0,
                costUsd,
              });
            }
            send("done", {
              subtype: r.subtype,
              costUsd,
              turns: r.num_turns,
              usage: r.usage,
            });
          }
        }

      } catch (e) {
        if (!abort.signal.aborted) send("error", { message: String(e) });
      } finally {
        // Fail-closed teardown: deny any permission requests still open on this
        // stream so their canUseTool promises unblock and no pending is leaked.
        for (const id of myPending) resolvePending(id, { behavior: "deny", reason: "aborted" });
        myPending.clear();
        // Persist in teardown, not in the happy path: a client disconnect
        // (navigation, closed tab) aborts the SDK loop with a throw, and the
        // turn must survive it — the SDK session already exists server-side.
        try {
          if (streamingText) parts.push({ type: "text", text: streamingText });
          if (capturedSession) {
            appendTurn({
              id: capturedSession,
              model,
              account: profile.name,
              project,
              userMessage: { role: "user", parts: [{ type: "text", text: message }] },
              assistantMessage: { role: "assistant", parts },
              costUsd,
            });
            send("saved", { chatId: capturedSession });
          }
        } catch {
          // persistence failure must never mask the stream teardown
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
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
