import crypto from "node:crypto";
import fs from "node:fs";
import { openCodeFailure, openCodeFailureText } from "./errors";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Message, SessionStatus, Part, PermissionRequest, QuestionRequest, Config } from "@opencode-ai/sdk/v2";
import { TELAR_MCP_SERVER, TELAR_BROWSER_MCP_SERVER, TELAR_SESSIONS_MCP_SERVER, type ItemDetail, type TurnObservation, type UserInputField } from "@telar/engine-client";
import { normalizeOutcome, type DriverRun, type TurnDriver } from "../provider-contract";
import { startOpenCodeRuntime, type OpenCodeRuntime } from "./runtime";

type Options = { start?: typeof startOpenCodeRuntime; pollMs?: number };
const requestOptions = () => ({ throwOnError: true as const, signal: AbortSignal.timeout(10_000) });

/**
 * REGISTERING A SERVER IS NOT A TEN-SECOND CALL, and computer use is the proof.
 *
 * `mcp.add` CONNECTS the server as part of adding it, against OpenCode's own
 * 30s connect budget — so the 10s every other call here uses was shorter than
 * the operation it was waiting on. cua-driver is exactly the server that needs
 * the difference: its `mcp` proxy auto-launches CuaDriver.app's
 * permission-holding daemon on first connect, and can sit behind a macOS grant
 * dialog while it does. Past 10s the request aborted, and because these calls
 * throw it took the whole TURN with it — a session that merely had computer use
 * installed could not run at all.
 */
const MCP_REGISTER_TIMEOUT_MS = 35_000;

/**
 * The claim's servers as OpenCode's own config, including Telar's `mac` server
 * when the claim carries one — computer use is not a special case here, it is
 * an ordinary stdio entry, which is the whole point of serving it over MCP.
 * `environment` is OVERLAID by OpenCode on the server process's own env, so a
 * local server keeps PATH and HOME exactly as the Claude driver's is spawned.
 *
 * Exported for the per-provider fixture — what a session receives is a claim
 * folded through here, and a test that asserted it any other way would be
 * asserting its own copy of this function.
 */
export function mcpConfiguration(input: DriverRun): NonNullable<Config["mcp"]> {
  const mcp: NonNullable<Config["mcp"]> = {};
  for (const server of input.mcpServers ?? []) {
    const spec = server.spec;
    if (spec.transport === "stdio") mcp[server.id] = { type: "local", command: [spec.command, ...(spec.args ?? [])], environment: spec.env };
    else mcp[server.id] = { type: "remote", url: spec.url, headers: spec.headers, oauth: false };
  }
  /**
   * `telar` IS IN THIS LIST, and that is what gives OpenCode the core toolkits
   * at all. Like Codex it takes MCP servers as CONFIG, so an in-process
   * registration reaches it never — the socket is the only transport all three
   * providers share, and it registers under the key those tools already ship
   * under so one tool has one qualified name everywhere.
   */
  for (const [name, socket] of [
    [TELAR_MCP_SERVER, input.telarSocketLease],
    [TELAR_BROWSER_MCP_SERVER, input.browserSocket],
    [TELAR_SESSIONS_MCP_SERVER, input.sessionsSocket],
  ] as const) {
    if (socket) mcp[name] = { type: "remote", url: socket.url, headers: { Authorization: `Bearer ${socket.token}` }, oauth: false };
  }
  return mcp;
}

export function openCodePartDetail(part: Part): ItemDetail | undefined {
  if (part.type === "text") return { type: "assistant_message", text: part.text };
  if (part.type === "reasoning") return { type: "reasoning", text: part.text };
  if (part.type === "tool") return { type: "dynamic_tool_call", call: { name: part.tool, toolUseId: part.callID,
    input: part.state.input, ...(part.state.status === "completed" ? { output: part.state.output } : {}),
    ...(part.state.status === "error" ? { output: part.state.error } : {}) } };
  return undefined;
}

/** Snapshot reconciliation is authoritative; SSE only accelerates refresh.
 * Reconnection never repeats a prompt. Each Telar session owns one server.
 */
export function createOpenCodeDriver(options: Options = {}): TurnDriver {
  const runtimes = new Map<string, { identity: string; runtime: OpenCodeRuntime; mcpNames: Set<string>; idle?: ReturnType<typeof setTimeout> }>();
  return {
    dispose() { for (const entry of runtimes.values()) { clearTimeout(entry.idle); entry.runtime.close(); } runtimes.clear(); },
    async run(input) {
      /**
       * `orientation` IS PART OF THE SERVER'S IDENTITY, and it has to be: the
       * briefings are baked into `OPENCODE_CONFIG_CONTENT` when the process
       * starts, so a reused server keeps the instructions file it was spawned
       * with. Without this, switching the toggle off would leave every live
       * OpenCode session still reading Telar's paragraph — which is the one
       * thing "off" must not mean. Same rule as the Claude driver's
       * fingerprint; a changed identity restarts the server.
       */
      const identity = JSON.stringify([input.cwd, input.binaryPath, input.providerInstanceId, input.env, input.orientation ?? null]);
      let owned = runtimes.get(input.sessionId);
      if (!owned || owned.identity !== identity || owned.runtime.closed) {
        owned?.runtime.close();
        owned = { identity, runtime: await (options.start ?? startOpenCodeRuntime)(input), mcpNames: new Set() };
        runtimes.set(input.sessionId, owned);
      }
      clearTimeout(owned.idle);
      const runtime = owned.runtime;
      try {
      const client = runtime.client;
      const mcp = mcpConfiguration(input);
      for (const name of owned.mcpNames) if (!(name in mcp)) await client.mcp.disconnect({ name }, requestOptions());
      /**
       * A SERVER THAT WILL NOT START COSTS ITS OWN TOOLS, NOT THE TURN — which
       * is what the Claude driver has always done with a bad `mcpServers` entry,
       * and what this one did not. Only the names that actually registered are
       * remembered, so the next turn retries the rest instead of believing they
       * are connected (and instead of disconnecting a name that never was).
       */
      const registered = new Set<string>();
      // Runtime MCP registration does not modify the user's opencode.json.
      for (const [name, config] of Object.entries(mcp)) {
        if (!("type" in config)) continue;
        try {
          await client.mcp.add({ name, config }, { throwOnError: true, signal: AbortSignal.timeout(MCP_REGISTER_TIMEOUT_MS) });
          registered.add(name);
        } catch (error) {
          // A cancelled turn is not a server that failed to start.
          if (input.signal.aborted) throw error;
        }
      }
      owned.mcpNames = registered;
      let sessionID = input.providerSessionId;
      if (sessionID) await client.session.get({ sessionID }, requestOptions());
      else sessionID = (await client.session.create({ title: "Telar", permission: [{ permission: "*", pattern: "*", action: "ask" }] }, requestOptions())).data!.id;
      await input.onObservations([{ kind: "provider.session", providerSessionId: sessionID }]);
      // A stable upstream ID makes admission reconcilable after a lost response.
      const messageID = `msg_${crypto.createHash("sha256").update(input.runId ?? crypto.randomUUID()).digest("hex").slice(0, 26)}`;
      const model = input.model?.includes("/") ? { providerID: input.model.slice(0, input.model.indexOf("/")), modelID: input.model.slice(input.model.indexOf("/") + 1) } : undefined;
      if (input.model && !model) throw new Error("OpenCode models must use provider/model IDs");
      const streamAbort = new AbortController();
      const seen = new Map<string, { text: string; signature: string; closed: boolean }>();
      const handled = new Set<string>();
      let callbackError: unknown;
      let wake: (() => void) | undefined;
      let admitted = false;
      let completed = false;
      let aborting: Promise<void> | undefined;
      const abort = () => {
        const admissionPending = !admitted;
        aborting ??= (async () => {
          try {
            await client.session.abort({ sessionID: sessionID! }, requestOptions());
            const status = await client.session.status({}, requestOptions());
            if (status.data?.[sessionID!]?.type !== "idle") runtime.close();
          }
          catch { runtime.close(); }
          // An admission whose acknowledgment raced Stop may land after abort.
          if (admissionPending) runtime.close();
        })();
        wake?.();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const events = (async () => {
        try {
          const subscription = await client.event.subscribe({}, { signal: streamAbort.signal });
          for await (const _event of subscription.stream) { wake?.(); if (streamAbort.signal.aborted) break; }
        } catch { /* periodic snapshots reconcile missed events */ }
      })();
      void events;
      const handle = (id: string, action: () => Promise<void>) => {
        if (handled.has(id)) return;
        handled.add(id);
        void action().catch((error) => { callbackError = error; wake?.(); });
      };
      const permission = async (request: PermissionRequest, parts: Part[]) => {
        const tool = parts.find((part) => part.type === "tool" && part.callID === request.tool?.callID);
        const outcome = normalizeOutcome(await input.onRequest?.({ kind: "tool_call", toolUseId: request.id,
          detail: { kind: "tool_call", call: { name: request.permission,
            input: tool?.type === "tool" ? tool.state.input : { patterns: request.patterns, metadata: request.metadata } } } }) ?? "decline");
        if (input.signal.aborted) return;
        await client.permission.reply({ requestID: request.id, reply: (outcome.decision === "accept" || outcome.decision === "acceptForSession") ? "once" : "reject" }, requestOptions());
      };
      const question = async (request: QuestionRequest) => {
        /**
         * ONE FIELD PER QUESTION, NEVER ONE PER OPTION — and `map` rather than
         * `flatMap` so that stays true by construction: `QuestionAnswer` is a
         * list POSITIONALLY per question, so the reply below can only be built
         * from a 1:1 mapping.
         *
         * A multi question used to explode into N `boolean` fields plus a text
         * field for a further answer, which is a form of checkboxes rather than
         * the ONE question it is: the request was no longer all-choice, so the
         * cockpit's question drawer and the phone's both refused it and fell to
         * the form card. `multiple: true` on a single `choice` field is the
         * contract's own way to say "pick any of these" (see `UserInputField`),
         * and it is what the Claude arm carries `multiSelect` out as.
         *
         * `custom` DOES NOT BRANCH THE MULTI ARM the way it branches the single
         * one below. Free text is the drawer's own affordance there — the
         * composer doubles as the answer box for any choice field — so keeping
         * the checklist costs nothing, whereas a second field of another kind
         * would cost the drawer entirely, which is the whole point of this. A
         * multi question with no options at all still falls through to the text
         * field, because a checklist of nothing is not a question.
         */
        const fields = request.questions.map((q, index): UserInputField => {
          const choices = q.options.map((option) => option.label);
          if (q.multiple && choices.length) return { key: String(index), label: q.question, kind: "choice", choices, multiple: true, required: true };
          return { key: String(index), label: q.question, kind: q.custom === false && choices.length ? "choice" : "text",
            ...(choices.length ? { choices } : {}), required: true };
        });
        const outcome = normalizeOutcome(await input.onRequest?.({ kind: "user_input", toolUseId: request.id,
          detail: { kind: "user_input", prompt: request.questions.map((q) => [q.question, ...q.options.map((option) => `${option.label}: ${option.description}`)].join("\n")).join("\n\n"),
            fields } }) ?? "decline");
        if (input.signal.aborted) return;
        if (outcome.decision !== "accept" && outcome.decision !== "acceptForSession") { await client.question.reject({ requestID: request.id }, requestOptions()); return; }
        const answers = fields.map((field) => {
          const value = outcome.answers?.[field.key];
          if (value === undefined) return [];
          if (!Array.isArray(value)) return [String(value)];
          // THE WIRE SHAPE IS A LIST EITHER WAY — that is `QuestionAnswer` —
          // but what may go in it is the FIELD's call. An array on a field that
          // never said `multiple` is a client bug, and the first pick is the
          // honest reading of it; passing the rest through would answer a
          // one-pick question with several. Same guard as the Codex arm.
          return field.multiple ? value.map(String) : value.slice(0, 1).map(String);
        });
        await client.question.reply({ requestID: request.id, answers }, requestOptions());
      };
      try {
        input.signal.throwIfAborted();
        /**
         * A NOTIFICATION IS A SYNTHETIC PART — issue #550.
         *
         * OpenCode has no developer or system role on `session.prompt`, but its
         * `TextPartInput` carries `synthetic` — the SDK's own word for "this was
         * generated, not typed" — and that is the distinction being made. It is
         * the OpenCode equivalent of the Claude driver's provenance stamp: the
         * flag is structural, so a peer's report cannot pass for the person's by
         * arriving on the same channel, and the notice's own text is what says
         * which peer and where to read them.
         */
        // An image-only message sends no text part — verified against OpenCode
        // 1.18.31: a prompt of one file part is admitted and the image is seen.
        const parts = [...(input.prompt.trim() || input.notification ? [{ type: "text" as const, text: input.prompt, ...(input.notification ? { synthetic: true } : {}) }] : []), ...(input.attachments ?? []).map((attachment) => ({
          type: "file" as const, mime: attachment.mediaType, filename: attachment.name,
          url: `data:${attachment.mediaType};base64,${fs.readFileSync(attachment.path).toString("base64")}`,
        }))];
        try { await client.session.promptAsync({ sessionID, messageID, model, parts }, requestOptions()); admitted = true; }
        catch (error) {
          if (input.signal.aborted) throw error;
          // Read admission by the exact message ID; never resend on uncertainty.
          try { await client.session.message({ sessionID, messageID }, requestOptions()); admitted = true; }
          catch { throw new Error("OpenCode prompt admission could not be confirmed; no automatic replay was attempted", { cause: error }); }
        }
        let failures = 0;
        for (;;) {
          input.signal.throwIfAborted();
          if (callbackError) throw callbackError;
          if (runtime.closed) throw new Error("OpenCode server exited");
          let snapshotRead = false;
          try {
            const permissionRead: Promise<{ data?: PermissionRequest[] }> = client.permission.list({}, requestOptions());
            const questionRead: Promise<{ data?: QuestionRequest[] }> = client.question.list({}, requestOptions());
            const [messages, statuses, permissions, questions]: [{ data?: Array<{ info: Message; parts: Part[] }> }, { data?: Record<string, SessionStatus> }, { data?: PermissionRequest[] }, { data?: QuestionRequest[] }] = await Promise.all([
              client.session.messages({ sessionID }, requestOptions()), client.session.status({}, requestOptions()),
              permissionRead, questionRead,
            ]);
            snapshotRead = true;
            failures = 0;
            input.signal.throwIfAborted();
            const responses = (messages.data ?? []).filter((m): m is typeof m & { info: AssistantMessage } => m.info.role === "assistant" && m.info.parentID === messageID);
            const parts = responses.flatMap((message) => message.parts);
            for (const request of permissions.data ?? []) if (request.sessionID === sessionID) handle(request.id, () => permission(request, parts));
            for (const request of questions.data ?? []) if (request.sessionID === sessionID) handle(request.id, () => question(request));
            const observations: TurnObservation[] = [];
            for (const message of responses) for (const part of message.parts) {
              const detail = openCodePartDetail(part);
              if (!detail) continue;
              const id = `oc_${part.id}`;
              const previous = seen.get(id);
              const text = part.type === "text" || part.type === "reasoning" ? part.text : "";
              const closed = part.type === "tool" ? part.state.status === "completed" || part.state.status === "error" : !!message.info.time.completed;
              const signature = JSON.stringify(detail);
              if (previous?.signature === signature && previous.closed === closed) continue;
              if (!previous) {
                observations.push({ kind: "item.started", item: { id, detail } });
                if (text) observations.push({ kind: "content.delta", itemId: id, stream: part.type === "reasoning" ? "reasoning_text" : "assistant_text", text });
              }
              if (previous && text.startsWith(previous.text) && text.length > previous.text.length) observations.push({ kind: "content.delta", itemId: id,
                stream: part.type === "reasoning" ? "reasoning_text" : "assistant_text", text: text.slice(previous.text.length) });
              if (closed) observations.push({ kind: "item.completed", itemId: id, detail,
                status: part.type === "tool" && part.state.status === "error" ? "failed" : "completed" });
              else observations.push({ kind: "item.updated", item: { id, detail } });
              seen.set(id, { text, signature, closed });
            }
            if (observations.length) await input.onObservations(observations);
            const last = responses.at(-1)?.info;
            if (last?.error) {
              // Sanitized and bounded — `APIError` carries `responseHeaders`
              // and `responseBody`, which never leave the SDK. See ./errors.ts.
              const failure = openCodeFailure(last.error);
              throw new Error(failure ? openCodeFailureText(failure) : "OpenCode: the turn failed.");
            }
            if (last?.time.completed && (statuses.data?.[sessionID]?.type === "idle" || statuses.data?.[sessionID] === undefined) && last.finish !== "tool-calls") {
              completed = true;
              return { providerSessionId: sessionID, text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
                usage: { tokens: { input: responses.reduce((sum, m) => sum + m.info.tokens.input, 0),
                  output: responses.reduce((sum, m) => sum + m.info.tokens.output, 0),
                  cacheRead: responses.reduce((sum, m) => sum + m.info.tokens.cache.read, 0),
                  cacheCreate: responses.reduce((sum, m) => sum + m.info.tokens.cache.write, 0),
                  reasoning: responses.reduce((sum, m) => sum + m.info.tokens.reasoning, 0) },
                  costUsd: responses.reduce((sum, m) => sum + m.info.cost, 0) } };
            }
          } catch (error) {
            if (snapshotRead || input.signal.aborted || callbackError || runtime.closed || ++failures >= 3) throw error;
          }
          await Promise.race([delay(options.pollMs ?? 300), new Promise<void>((resolve) => { wake = resolve; })]);
          wake = undefined;
        }
      } finally {
        streamAbort.abort(); input.signal.removeEventListener("abort", abort);
        if (!completed) { abort(); await aborting; }
        else {
          owned.idle = setTimeout(() => { runtime.close(); if (runtimes.get(input.sessionId) === owned) runtimes.delete(input.sessionId); }, 10 * 60_000);
          owned.idle.unref();
        }
      }
      } catch (error) { runtime.close(); throw error; }
    },
  };
}
