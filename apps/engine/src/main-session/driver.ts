/**
 * TELAR'S OWN AGENT LOOP — the Main assistant's driver (#526).
 *
 * Every other driver in this engine adapts a harness somebody else installed.
 * This one IS the harness: it builds the conversation, calls a model API,
 * streams the answer back as journal rows, dispatches the tool calls the model
 * asks for, and does it again until the model stops. There is no subprocess, no
 * SDK and no working directory — which is the point, because the conversation
 * it serves has no checkout either.
 *
 * ── WHAT IT CAN DO, AND WHY THAT LIST IS SHORT ──────────────────────────────
 * The sessions wall and the notes wall. No shell, no browser, no files, no
 * notebooks, no runs — not disabled, ABSENT: the driver never registers them,
 * so the model has no such tool and says so rather than trying and being
 * refused. A coordinator inspects and delegates; repository work belongs to the
 * sessions it delegates to, and a coordinator that could edit files itself
 * would simply be another worker with a better view of the rail.
 *
 * ── THE SAME GATE AS EVERY OTHER DRIVER ─────────────────────────────────────
 * Each call goes through `onRequest`, which is the worker's `askEngine` — the
 * same path a Claude tool call takes, so the session's runtime mode decides,
 * an approval parks for a human, and a decline reaches the model as a result it
 * can read. Nothing about being the Main session widens any of that.
 *
 * ── THE TRANSPORT IS `fetch`, AND THE STREAM IS PARSED HERE ─────────────────
 * See `./go.ts` for why there is no client library. The wire format is
 * OpenAI-compatible SSE: `data: {json}` frames, `data: [DONE]` at the end, with
 * text arriving as `choices[0].delta.content` and tool calls as
 * `choices[0].delta.tool_calls[]` fragments that have to be reassembled by
 * index — a name in one frame, its arguments spread across a dozen more.
 *
 * ── A TURN IS A LOOP, NOT A REQUEST ─────────────────────────────────────────
 * One turn is: send, stream, and if the model finished by calling tools, run
 * them, append the results and send again. `MAX_ROUNDS` bounds that, because
 * the one way a loop like this burns a person's credit unattended is by
 * deciding to call one more tool for ever.
 */
import type { Item, ItemDetail, TurnObservation, UsageSnapshot } from "@telar/engine-client";
import { collectTools, toolInputSchema, type SocketTool } from "../mcp-socket";
import { notesTools } from "../notes-tools/tools";
import { sessionsTools } from "../sessions-tools/tools";
import { normalizeOutcome, ProviderUnavailableError, type DriverRun, type DriverResult, type TurnDriver } from "../provider-contract";
import { describeGoCredential, redactKey, resolveGoCredential, type GoCredential } from "../agent/credentials";
import { buildGoMessages, type GoMessage, type GoToolCall } from "./history";
import { DEFAULT_GO_MODEL, goHeaders, OPENCODE_GO_BASE } from "../agent/go";

/**
 * HOW MANY TIMES ONE TURN MAY GO BACK TO THE MODEL.
 *
 * A model that keeps calling tools keeps costing money, and nobody is watching
 * a coordinator at 3am. Twelve is generous for the work this loop actually does
 * — read the rail, read a session, send a task, report — and small enough that
 * a loop costs a person a few calls rather than a night. Reaching it ends the
 * turn with what has been said so far plus a line saying why it stopped, which
 * is strictly better than an answer that never comes.
 */
const MAX_ROUNDS = 12;

/** How long one streaming request may go without the stream ending. Generous:
 *  a model thinking hard is not a hung socket, and the turn's own abort signal
 *  is what a person presses. */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

/** How many of the session's recent turns the history is rebuilt from. The
 *  character budget is the real bound; this keeps the READ cheap on a session
 *  with a thousand turns behind it. */
const TRANSCRIPT_TURNS = 80;

export type TelarDriverOptions = {
  /** Injected so tests drive a local server and never the real API. */
  fetchImpl?: typeof fetch;
  /** Overridden by tests to point at that server. */
  base?: string;
  /** Rung 3 of the credential ladder, injected so no test reads a real home. */
  readCliKey?: () => string | undefined;
  maxRounds?: number;
};

/** What the model is told it is. The engine's `mainBriefing` is the role; this
 *  is the sentence that makes a bare API call behave like an agent at all. */
const FALLBACK_SYSTEM =
  "You are Telar's Main assistant. You coordinate this machine's work: you inspect projects and sessions, " +
  "delegate bounded tasks to project sessions, and report what changed. You own no checkout and no files.";

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

/**
 * The tools this turn has, collected through the SAME factory seam the MCP
 * socket and every toolkit test use.
 *
 * A PLAIN `ToolFactory`, NOT A SOCKET. The other two non-Claude drivers take
 * MCP servers as configuration and therefore need a worker-hosted HTTP wall;
 * this driver runs inside the worker with the capabilities in hand, so a socket
 * would be a loopback round trip and a credential for a call between two
 * functions. `collectTools` is exactly the seam that makes the tool list the
 * same one either way.
 *
 * A CAPABILITY THE TURN DOES NOT CARRY MEANS NO WALL, never an empty one — the
 * rule `collectTelarWall` states. A project-less session has no notebook, so
 * the Main assistant has no `notes_*` tools unless the turn was given some.
 */
export function telarWallTools(input: Pick<DriverRun, "sessions" | "notes">): SocketTool[] {
  const tools: SocketTool[] = [];
  if (input.sessions) tools.push(...collectTools(sessionsTools as never, input.sessions as never));
  if (input.notes) tools.push(...collectTools(notesTools as never, input.notes as never));
  return tools;
}

/** One tool as the chat API's `tools` entry. The descriptions the walls wrote
 *  for a model ride along unchanged — they are the tool's whole documentation. */
function toolSpec(tool: SocketTool): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool.shape) },
  };
}

/* ------------------------------------------------------------------ *
 * The wire.
 * ------------------------------------------------------------------ */

/** One reassembled tool call. `arguments` arrives in fragments and is only
 *  parseable once the stream says the model has finished asking. */
type PendingCall = { id: string; name: string; arguments: string };

/** What one streamed response amounted to. */
type RoundResult = {
  text: string;
  calls: PendingCall[];
  finish?: string;
  usage?: UsageSnapshot;
};

/**
 * The server said no, in its own words.
 *
 * SURFACED VERBATIM (minus any key it echoed) rather than translated. A 401 is
 * "your key is wrong" and a 429 is "you are over a limit" — both are things the
 * person must act on, and both are said better by the service that knows which
 * limit than by a sentence written here months earlier. The status rides along
 * because it is what the settings pane keys the setup prompt off.
 */
export class GoRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoRequestError";
  }
}

/** The usage block, as OpenAI-compatible servers report it. Absent fields stay
 *  absent: a zero would claim a measurement nobody made. */
function usageOf(payload: unknown): UsageSnapshot | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const input = typeof row.prompt_tokens === "number" ? row.prompt_tokens : undefined;
  const output = typeof row.completion_tokens === "number" ? row.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { tokens: { input: input ?? 0, output: output ?? 0, cacheRead: 0, cacheCreate: 0 } };
}

/**
 * SSE, BY HAND.
 *
 * The format is small and the corner that matters is BUFFERING: a frame can be
 * split across two network reads at any byte, so the decoder is streaming and
 * the split is on the blank line that terminates an event, never on whatever
 * one `read()` happened to return. A `data:` line is JSON except for the
 * sentinel `[DONE]`; anything else in the frame (a comment, an `event:` line)
 * is ignored rather than guessed at.
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // A frame that is not JSON is not a turn failure: the stream is
            // still good and the next frame may be the answer. Dropped
            // silently, because the alternative is a journal line per
            // keep-alive on a chatty server.
          }
        }
      }
    }
  } finally {
    // Cancelling is what actually closes the socket when a turn is stopped
    // mid-stream; without it the request hangs on until the server gives up.
    await reader.cancel().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * The driver.
 * ------------------------------------------------------------------ */

export function createTelarDriver(options: TelarDriverOptions = {}): TurnDriver {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.base ?? OPENCODE_GO_BASE;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;

  return {
    async run(input: DriverRun): Promise<DriverResult> {
      /**
       * THE KEY, RESOLVED ONCE PER TURN AND HELD ONLY IN THIS SCOPE. Not
       * cached across turns: a person who pastes a key, or revokes one in the
       * CLI, gets the new answer on the next message rather than on the next
       * restart.
       */
      const credential = resolveGoCredential({
        instanceEnv: input.env,
        ...(options.readCliKey ? { readCliKey: options.readCliKey } : {}),
      });
      if (!credential) {
        // `ProviderUnavailableError` is the contract's "this provider cannot
        // run here" — the same shape a missing CLI produces, which is what the
        // settings pane already knows how to talk about.
        throw new ProviderUnavailableError(
          "Telar's Main assistant needs an OpenCode Go key. Paste one in Settings, or set OPENCODE_API_KEY, or sign the OpenCode CLI in.",
        );
      }

      const tools = telarWallTools(input);
      const model = input.model ?? DEFAULT_GO_MODEL;
      const system = [input.mainBriefing ?? FALLBACK_SYSTEM, ...(input.orientation ? [input.orientation] : [])].join("\n\n");

      /**
       * THE CONVERSATION SO FAR. A turn with no `transcript` capability gets an
       * empty history rather than an error — that is a test, or a worker older
       * than the field, and a first message is a legitimate conversation.
       */
      const items: Item[] = input.transcript ? await input.transcript({ turns: TRANSCRIPT_TURNS }).catch(() => []) : [];
      const messages: GoMessage[] = buildGoMessages({
        system,
        items,
        prompt: input.prompt,
        ...(input.runId ? { currentRunId: input.runId } : {}),
      });

      let text = "";
      let usage: UsageSnapshot | undefined;
      let stoppedAtCap = false;

      for (let round = 0; round < maxRounds; round += 1) {
        input.signal.throwIfAborted();
        const answer = await unauthorizedAsUnavailable(() =>
          streamRound({
            doFetch,
            base,
            credential,
            sessionId: input.sessionId,
            model,
            messages,
            tools,
            signal: input.signal,
            round,
            runId: input.runId ?? input.sessionId,
            onObservations: input.onObservations,
          }),
        );
        if (answer.usage) usage = mergeUsage(usage, answer.usage);
        if (answer.text) text = answer.text;

        if (answer.calls.length === 0) return { text, ...(usage ? { usage } : {}) };

        /**
         * THE ASSISTANT'S OWN TURN GOES BACK FIRST, calls included. The chat
         * format requires the `tool` messages to follow the assistant message
         * that asked for them; sending results with no call is a 400, and
         * sending the call without the text loses whatever the model said
         * alongside it.
         */
        messages.push({
          role: "assistant",
          content: answer.text,
          tool_calls: answer.calls.map(
            (call): GoToolCall => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } }),
          ),
        });

        for (const call of answer.calls) {
          input.signal.throwIfAborted();
          const result = await dispatch({ call, tools, input });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }

        if (round === maxRounds - 1) stoppedAtCap = true;
      }

      /**
       * THE CAP, STATED RATHER THAN HIDDEN. The turn ends with whatever the
       * model has said plus one sentence saying why it stopped — a person
       * reading the transcript can then decide whether to send it on, and the
       * alternative (a silent stop) looks exactly like a model that gave up.
       */
      const capped = `${text}${text ? "\n\n" : ""}[Telar stopped this turn after ${maxRounds} rounds of tool calls. Send again to continue.]`;
      return { text: stoppedAtCap ? capped : text, ...(usage ? { usage } : {}) };
    },
  };
}

/**
 * A REJECTED KEY IS "this provider cannot run here", not "the turn broke".
 *
 * 401 and 403 are the two statuses that mean the credential is the problem, and
 * the difference matters twice over. For the PERSON, `provider_unavailable` is
 * the failure the cockpit already knows how to talk about — the same one a
 * missing CLI produces — rather than a generic driver fault. For the SETTINGS
 * PANE, it is the durable signal that flips the key field back to setup: the
 * engine reads the Main session's newest settled turn and needs one code to key
 * that off, without parsing anybody's prose.
 *
 * THE SERVICE'S OWN WORDS SURVIVE THE TRANSLATION. Only the class changes.
 * Every other status — 429 above all — stays a `GoRequestError`, because a rate
 * limit is a wait to sit out and not a login to fix.
 */
async function unauthorizedAsUnavailable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoRequestError && (error.status === 401 || error.status === 403)) {
      throw new ProviderUnavailableError(error.message);
    }
    throw error;
  }
}

/** Two usage snapshots, added. A turn is several requests and the person is
 *  billed for all of them; reporting only the last would understate it. */
function mergeUsage(left: UsageSnapshot | undefined, right: UsageSnapshot): UsageSnapshot {
  if (!left) return right;
  return {
    tokens: {
      input: (left.tokens?.input ?? 0) + (right.tokens?.input ?? 0),
      output: (left.tokens?.output ?? 0) + (right.tokens?.output ?? 0),
      cacheRead: (left.tokens?.cacheRead ?? 0) + (right.tokens?.cacheRead ?? 0),
      cacheCreate: (left.tokens?.cacheCreate ?? 0) + (right.tokens?.cacheCreate ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ *
 * One request, streamed.
 * ------------------------------------------------------------------ */

async function streamRound(input: {
  doFetch: typeof fetch;
  base: string;
  credential: GoCredential;
  sessionId: string;
  model: string;
  messages: GoMessage[];
  tools: SocketTool[];
  signal: AbortSignal;
  round: number;
  runId: string;
  onObservations: DriverRun["onObservations"];
}): Promise<RoundResult> {
  // The turn's own abort AND a ceiling, because a socket that never closes is
  // not the same failure as a person pressing Stop and must not look like one.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeout]);

  let response: Response;
  try {
    response = await input.doFetch(`${input.base}/chat/completions`, {
      method: "POST",
      headers: goHeaders({ apiKey: input.credential.key, sessionId: input.sessionId, json: true }),
      body: JSON.stringify({
        model: input.model,
        stream: true,
        // Asked for explicitly: without it an OpenAI-compatible stream reports
        // no usage at all, and a turn with no token count is a turn missing
        // from the usage report.
        stream_options: { include_usage: true },
        messages: input.messages,
        ...(input.tools.length > 0 ? { tools: input.tools.map(toolSpec), tool_choice: "auto" } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    // The key can appear in a transport error only if something echoed the
    // header back; scrubbed anyway, on the rule that a backstop costs nothing.
    throw new Error(redactKey(error instanceof Error ? error.message : String(error), input.credential.key));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = redactKey(body.trim(), input.credential.key).slice(0, 2000);
    throw new GoRequestError(
      response.status,
      // The service's own words first, because they are the specific ones; the
      // status and the rung are the context that makes them actionable.
      `OpenCode Go answered ${response.status}${detail ? `: ${detail}` : "."} (${describeGoCredential(input.credential)})`,
    );
  }
  if (!response.body) throw new Error("OpenCode Go returned no stream to read.");

  /**
   * ONE ITEM PER ROUND FOR THE ASSISTANT'S PROSE, opened on the first token
   * rather than up front: a round that only calls tools should not leave an
   * empty speech bubble in the transcript.
   */
  const textItemId = `telar_${input.runId}_${input.round}_text`;
  let opened = false;
  let text = "";
  const pending = new Map<number, PendingCall>();
  let finish: string | undefined;
  let usage: UsageSnapshot | undefined;

  for await (const chunk of readSseFrames(response.body, signal)) {
    if (input.signal.aborted) break;
    usage = usageOf(chunk) ?? usage;
    const choice = firstChoice(chunk);
    if (!choice) continue;
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content) {
      const observations: TurnObservation[] = [];
      if (!opened) {
        opened = true;
        observations.push({ kind: "item.started", item: { id: textItemId, detail: { type: "assistant_message", text: "" } } });
      }
      text += delta.content;
      observations.push({ kind: "content.delta", itemId: textItemId, stream: "assistant_text", text: delta.content });
      await input.onObservations(observations);
    }

    for (const fragment of delta.tool_calls ?? []) {
      const index = typeof fragment.index === "number" ? fragment.index : 0;
      const call = pending.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id) call.id = fragment.id;
      if (typeof fragment.function?.name === "string" && fragment.function.name) call.name = fragment.function.name;
      if (typeof fragment.function?.arguments === "string") call.arguments += fragment.function.arguments;
      pending.set(index, call);
    }
  }

  if (opened) {
    await input.onObservations([
      { kind: "item.completed", itemId: textItemId, status: "completed", detail: { type: "assistant_message", text } },
    ]);
  }
  if (usage) await input.onObservations([{ kind: "usage", usage }]);

  /**
   * A CALL WITH NO ID IS DROPPED, never run with an invented one. The id is
   * what pairs the result back to the call, and the model's next request would
   * carry a `tool_call_id` the conversation has never seen.
   */
  const calls = [...pending.entries()].sort(([left], [right]) => left - right).map(([, call]) => call).filter((call) => call.id && call.name);

  return { text, calls, ...(finish ? { finish } : {}), ...(usage ? { usage } : {}) };
}

type StreamChoice = {
  finish_reason?: unknown;
  delta?: {
    content?: unknown;
    tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
  };
};

/** The one choice this loop reads. `n > 1` is never requested, so a second one
 *  would be a server being generous rather than an answer anybody asked for. */
function firstChoice(chunk: unknown): StreamChoice | undefined {
  if (typeof chunk !== "object" || chunk === null) return undefined;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  return typeof choice === "object" && choice !== null ? (choice as StreamChoice) : undefined;
}

/* ------------------------------------------------------------------ *
 * One tool call.
 * ------------------------------------------------------------------ */

/**
 * Ask the engine, run the tool, journal both halves, and hand the model a
 * string it can read.
 *
 * EVERY OUTCOME IS A TOOL RESULT, never a thrown error. A refusal, an unknown
 * tool name, unparseable arguments and a handler that threw are all things the
 * model can respond to — it can ask the person, pick another tool, or fix its
 * arguments. Turning any of them into a failed turn would throw away a
 * conversation over one bad call.
 */
async function dispatch(context: { call: PendingCall; tools: SocketTool[]; input: DriverRun }): Promise<string> {
  const { call, tools, input } = context;
  const itemId = `telar_tool_${call.id}`;
  const tool = tools.find((candidate) => candidate.name === call.name);

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    args = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Reported as a finished, failed row rather than an open one: the call
    // happened and is over, and the model is told exactly what to fix.
    const message = "The arguments were not valid JSON. Send this tool call again with a valid JSON object.";
    await report(input, itemId, { name: call.name, toolUseId: call.id, input: call.arguments, output: message }, "failed");
    return message;
  }

  const detail = { name: call.name, toolUseId: call.id, input: args };
  await input.onObservations([{ kind: "item.started", item: { id: itemId, detail: { type: "dynamic_tool_call", call: detail } } }]);

  if (!tool) {
    const message = `There is no tool called ${call.name} in this conversation. Use one of the tools you were given.`;
    await report(input, itemId, { ...detail, output: message }, "failed");
    return message;
  }

  /**
   * THE ENGINE'S GATE, ON THE SAME TERMS AS EVERY OTHER DRIVER. No gate at all
   * is the `full-access` shape and is what the tests use — the contract says
   * so, and a driver that refused without one would make every test a
   * permissions test.
   */
  const outcome = normalizeOutcome(
    (await input.onRequest?.({ kind: "tool_call", toolUseId: call.id, detail: { kind: "tool_call", call: detail } })) ?? "accept",
  );
  if (outcome.decision !== "accept" && outcome.decision !== "acceptForSession") {
    const message = "The person declined this tool call. Do not retry it; ask them what to do instead.";
    await report(input, itemId, { ...detail, output: message }, "failed");
    return message;
  }

  try {
    const answer = await tool.run(args);
    const output = textOf(answer.content);
    await report(input, itemId, { ...detail, output }, answer.isError ? "failed" : "completed");
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(input, itemId, { ...detail, output: message }, "failed");
    return message;
  }
}

/** Close a tool row with what it produced. One helper because every branch of
 *  `dispatch` ends this way and a missed one leaves an open row for ever. */
async function report(
  input: DriverRun,
  itemId: string,
  call: { name: string; toolUseId: string; input?: unknown; output?: unknown },
  status: "completed" | "failed",
): Promise<void> {
  const detail: ItemDetail = { type: "dynamic_tool_call", call };
  await input.onObservations([{ kind: "item.completed", itemId, status, detail }]);
}

/** An MCP content list as the one string a chat `tool` message carries. */
function textOf(content: unknown[]): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string") {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.join("\n");
}
