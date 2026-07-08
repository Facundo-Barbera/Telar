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
import { capToolInput, capToolOutput, extractToolResultText } from "@/lib/transcript";

const toIso = (epoch?: number) =>
  epoch ? new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString() : null;

// Hard ceiling on how many tool calls a single turn persists with full
// input/output detail. capToolInput/capToolOutput bound each part's own
// size, but nothing bounds the COUNT — a pathological (e.g. repo-wide
// refactor) turn can carry hundreds of tool calls across maxTurns rounds,
// and store.ts rewrites the entire chats.json synchronously on every
// appendTurn. Beyond this ceiling, later tool parts degrade to name-only
// (the shape this diff's tool parts had before) so one outlier turn can't
// blow up chats.json or the blocking write it forces on every other chat.
const MAX_DETAILED_TOOL_PARTS = 200;

// One POST = one turn. Continuation via `resume: sessionId`; the SDK restores
// full conversation state from the session transcript. Token-level streaming
// via includePartialMessages; client abort propagates to the subprocess.
export async function POST(req: Request) {
  const {
    message,
    sessionId,
    model = DEFAULT_MODEL,
    project,
    account,
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

  // Same treatment as the project check: an unknown account is a plain 400
  // before any stream opens, not something canUseTool/the SDK ever sees.
  // hasOwnProperty (not `in`) so inherited Object.prototype keys like
  // "constructor"/"toString" can't slip past this as a false "known account".
  if (account != null && !Object.prototype.hasOwnProperty.call(ACCOUNTS, account)) {
    return Response.json(
      { error: `Unknown account "${account}".` },
      { status: 400 },
    );
  }

  // Caller-supplied account wins (existing chats resume with their persisted
  // chat.account, passed explicitly here), then the project's manifest
  // default, then "personal". See AGENTS notes on the account-lock: a
  // session's resume transcript lives under the account's config dir, so
  // this route trusts whatever the client sends — the picker being
  // choosable only pre-first-turn is a client-side rule, not enforced here.
  const profile = ACCOUNTS[account] ?? ACCOUNTS[manifest.account] ?? ACCOUNTS.personal;
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
      // parts[i]'s originating SDKMessage uuid, index-aligned with `parts` —
      // scratch bookkeeping so a later refusal-fallback `supersedes` list can
      // evict the exact entries it retracts (see the "assistant" handler).
      const partOrigin: (string | undefined)[] = [];
      let streamingText = ""; // text accumulated from deltas for current block
      // The resume target is the client-supplied id, but it's untrusted until
      // the SDK actually confirms it via a system:init message below.
      // capturedSession must only ever hold an SDK-confirmed id — the finally
      // block persists a turn whenever it's truthy, and a resume that fails
      // before init (e.g. session doesn't exist under this account's config
      // dir) must not persist a phantom empty turn under the client's guess.
      const resumeTarget = sessionId ?? null;
      let capturedSession: string | null = null;
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
            ...(resumeTarget ? { resume: resumeTarget } : {}),
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
            const init = msg as {
              session_id: string;
              slash_commands?: string[];
              skills?: string[];
            };
            capturedSession = init.session_id;
            send("session", {
              sessionId: capturedSession,
              slashCommands: init.slash_commands ?? [],
              skills: init.skills ?? [],
            });
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
            // A non-null parent_tool_use_id means this message came from a
            // subagent's own internal conversation (e.g. spawned via Task),
            // relayed on this same top-level stream. Skip it — its tool
            // calls aren't the top-level turn's own actions and must not be
            // flattened into this turn's transcript as if they were.
            if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
              continue;
            }
            const msgUuid = (msg as { uuid?: string }).uuid;
            const content =
              (msg as { message?: { content?: Array<Record<string, any>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type === "text") {
                parts.push({ type: "text", text: block.text as string });
                partOrigin.push(msgUuid);
                send("text", { text: block.text }); // finalize the streamed block
                streamingText = "";
              }
              if (block.type === "tool_use") {
                const id = block.id as string;
                const name = block.name as string;
                const input = capToolInput(
                  (block.input ?? {}) as Record<string, unknown>,
                );
                parts.push({ type: "tool", id, name, input });
                partOrigin.push(msgUuid);
                send("tool", { id, name, input });
              }
            }
            // Refusal-fallback retry: the SDK retried on a fallback model and
            // this message's `supersedes` names the wire uuids of previously
            // -delivered message frames it replaces (including tombstoned
            // tool_result frames from the refused leg). Evict whatever this
            // turn already queued from those frames so a retracted tool call
            // never gets persisted as if the model's final output included it.
            const supersedes = (msg as { supersedes?: string[] }).supersedes;
            if (supersedes?.length) {
              const dead = new Set(supersedes);
              for (let i = parts.length - 1; i >= 0; i--) {
                const origin = partOrigin[i];
                if (origin && dead.has(origin)) {
                  parts.splice(i, 1);
                  partOrigin.splice(i, 1);
                }
              }
            }
          } else if (msg.type === "user") {
            // Tool results: the SDK relays the model's `user` turn carrying
            // tool_result blocks. Attach output/isError onto the matching
            // "tool" part (by tool_use_id) so persistence includes results,
            // and mirror the same data over SSE. A tool_result whose id
            // matches no part pushed above is subagent/side-channel noise
            // (not part of this turn's visible transcript) — skip it rather
            // than crash or emit a dangling event.
            if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
              continue;
            }
            const content =
              (msg as { message?: { content?: Array<Record<string, any>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              const id = block.tool_use_id as string;
              const part = parts.find(
                (p): p is Extract<Part, { type: "tool" }> =>
                  p.type === "tool" && p.id === id,
              );
              if (!part) continue;
              // A duplicate/retried delivery for the same tool_use_id: first
              // write wins rather than silently overwriting an already
              // -resolved result with a second (possibly stale) one.
              if (part.output !== undefined) continue;
              const output = capToolOutput(extractToolResultText(block.content));
              const isError = !!block.is_error;
              part.output = output;
              part.isError = isError;
              send("tool_result", { id, output, isError });
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
          // A tool part still missing output at this point never got a
          // matching tool_result — the turn was aborted or crashed mid-flight
          // (a graceful "result" message only arrives once every tool call
          // belonging to it has resolved, denials included). Flag it so the
          // client can render "interrupted" instead of rendering identically
          // to a genuinely empty successful result.
          for (const part of parts) {
            if (part.type === "tool" && part.output === undefined) {
              part.interrupted = true;
            }
          }
          let detailedTools = 0;
          for (const part of parts) {
            if (part.type !== "tool") continue;
            if (++detailedTools > MAX_DETAILED_TOOL_PARTS) {
              delete part.input;
              delete part.output;
            }
          }
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
