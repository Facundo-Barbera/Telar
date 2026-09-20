/**
 * THE AGENT'S MODEL — OpenCode Go's three routes, behind one factory (#531, #571).
 *
 * ── ONE FUNCTION, THREE CLIENTS, AND THE RUNTIME KNOWS ABOUT NONE OF THEM ───
 * Go serves 38 ids on three endpoints: `/chat/completions`, an Anthropic-shaped
 * `/messages`, and OpenAI's `/responses` (`agent/catalogue.ts` holds the table).
 * `goRouteOf` decides which, and this file builds the matching client —
 * `ChatOpenAI`, `ChatAnthropic`, or `ChatOpenAI` in its Responses mode. What
 * comes back is a `BaseChatModel` either way, which is the entire point: the
 * graph in `runtime.ts` hands it messages and gets tool calls back as objects,
 * and there is no route branch anywhere above this return statement. A route is
 * a fact about a URL, not about how a turn behaves, and
 * `agent-runtime-parity.test.ts` runs the same scenarios over all three client
 * shapes to keep it that way.
 *
 * ── WHY CLIENT LIBRARIES HERE, WHEN `./go.ts` ARGUES AGAINST ONE ────────────
 * `go.ts` uses raw `fetch` and says why: the surface it needs is two
 * OpenAI-compatible endpoints, and a dependency for that is a dependency for
 * its whole tree. Nothing about that has changed — `readOpenCodeGoModels` still
 * uses `fetch` and still should. What changed is the CALLER. A LangGraph node
 * hands its messages to a `BaseChatModel` and gets tool calls back as objects;
 * reimplementing that interface over `fetch` would mean re-deriving streaming
 * deltas, tool-call fragment reassembly and usage metadata into LangChain's own
 * shapes — three times over, once per wire format — which is precisely what
 * `@langchain/openai` and `@langchain/anthropic` are.
 *
 * ── THE KEY IS NOT THIS FILE'S BUSINESS ─────────────────────────────────────
 * `resolveGoCredential` answers where a key comes from and nothing here caches,
 * logs or returns one. It is resolved per call for `main-session/driver.ts`'s
 * own reason: a person who pastes a key, or revokes one in the CLI, gets the
 * new answer on their next message rather than on the next restart.
 *
 * ── THE THREE HEADERS, AND WHY `defaultHeaders` IS NOT ENOUGH ───────────────
 * The credential, `User-Agent: telar/<version>` and `x-opencode-session:
 * <threadId>`. The last two are `goHeaders`' own, read from there rather than
 * spelled again, so the Agent introduces itself exactly as the rest of this
 * engine does and a log on the other side sees one product rather than two.
 *
 * THE CREDENTIAL HEADER IS THE ROUTE'S OWN, AND IT IS MEASURED, NOT ASSUMED.
 * opencode.ai/docs/go publishes the base URL and the session header and says
 * nothing about auth; it names the AI SDK package per route, and those differ.
 * Asked directly on 2026-09-17, with one request each:
 *
 *   /chat/completions, /responses  →  `Authorization: Bearer <key>`
 *   /messages                      →  `x-api-key: <key>`; a Bearer alone is
 *                                     `401 {"type":"AuthError","message":
 *                                     "Missing API key."}`, and the reverse is
 *                                     a 401 on `/responses`.
 *
 * Each client library already sends its own family's header from `apiKey`, so
 * the right answer is to let it and to force nothing here — see the note at the
 * `forced` destructure.
 *
 * MEASURED: `configuration.defaultHeaders` does NOT carry `User-Agent` through.
 * `@langchain/openai` sets its own (`langchainjs-openai/1.0.0 (node/…)`) and it
 * wins, so the agent string opencode.ai/docs/go asks for would never have
 * arrived — silently, since a wrong `User-Agent` costs nothing at the call and
 * everything in somebody else's log. The headers are therefore applied in a
 * `fetch` WRAPPER, which is the one layer below anything the client library can
 * override. `agent-model.test.ts` asserts what actually reached the socket
 * rather than what was configured.
 *
 * ── AND THE SAME WRAPPER TAKES ONE FIELD BACK OFF (#549) ────────────────────
 * `withoutMessageNames` strips `name` from every outgoing message. The runtime
 * is where that field stopped being set; this is the guard that keeps a library
 * version from reintroducing it, for the same reason the headers are forced
 * here — it is the last place the request is still ours. See the note on it.
 *
 * ONE WRAPPER FOR ALL THREE ROUTES, and it is the same wrapper deliberately.
 * The headers are promises `go.ts` makes to the service and they do not vary by
 * endpoint; the `name` strip is a no-op on the two routes that do not carry a
 * `messages` array of that shape, which is exactly what it was written to be —
 * see its note on leaving a body it has nothing to do with byte-identical.
 *
 * ── THE ONE FIELD THAT COMES BACK AND NEVER GOES OUT AGAIN (#613) ───────────
 * `reasoning_content`. The chat route's models think — `deepseek-v4.1-flash`,
 * which the Agent runs, returns the field on every answer, with or without
 * `reasoning_effort` — and `@langchain/openai` 1.5.13 captures it into
 * `additional_kwargs` and then omits it when that same message is serialised
 * back. So the Agent keeps the model's thinking in its checkpoint and never
 * shows it to the model again, and NOTHING HERE PUTS IT BACK.
 *
 * DELIBERATELY, BECAUSE THE PROVIDER DOES NOT ASK FOR IT ON THE REQUEST THIS
 * FACTORY BUILDS. Measured against Go on 2026-09-18: a six-message history with
 * two assistant tool-call messages, all of them stripped of the field, is
 * ACCEPTED when the request carries `reasoning_effort` and `stream: true` — what
 * a turn sends — and REFUSED with `400 … The reasoning_content in the thinking
 * mode must be passed back to the API` when it carries neither, which is how the
 * live cache smoke found it. Writing the echo would mean inventing a field this
 * route's client does not serialise, onto a body no server has yet rejected.
 *
 * IT IS A HAZARD ON A SHORT LEASH, THOUGH, AND THE LEASH IS A SETTING. The two
 * parameters were moved TOGETHER, so which of them does the immunising is not
 * measured — and that is the point rather than a gap to shrug at: an `agent.json`
 * with no `effort` sends no `reasoning_effort`, and if that is the one that
 * matters, clearing a settings field is all it takes to make every three-lap turn
 * a 400. One live call with the failing history and only the effort restored
 * would settle it. `agent-model.test.ts` pins the round trip meanwhile, so the day
 * a client library starts echoing the field is a failing test rather than a
 * silent change.
 *
 * ── AND ONE FIELD GOES ON, ON THE ONE ROUTE THAT HAS IT (#563 item 3) ───────
 * `withAnthropicCaching` puts `cache_control` breakpoints on an Anthropic-shaped
 * body and leaves every other body byte-identical, by the same shape test and
 * for the same reason. The two routes it skips are not missing a feature: their
 * caching is the PROVIDER'S, automatic, and conditional on the prefix not moving
 * between calls — so the most useful thing this file can do for them is change
 * nothing, which is what it does. `agent-prefix.test.ts` measures that the
 * prefix really does hold; `agent-model.test.ts` asserts what reaches the wire
 * on each route here.
 *
 * ── AND THE WRAPPER WATCHES WHAT COMES BACK, WITHOUT READING IT (#710) ──────
 * A provider that answers 200 with a body that is not a completion raises
 * nothing on the way in, and every client library on this path then dies
 * reading a field of `undefined` three frames down — naming no model, no route,
 * and not the fact that a provider was involved. The wrapper records the
 * ENVELOPE of each response (status, content type, length; never the body, so a
 * credential cannot reach a message built from it) and the two model classes
 * below raise the sentence. IT RECORDS RATHER THAN RAISES DELIBERATELY: an
 * error thrown from `fetch` is a connection failure as far as an SDK is
 * concerned, and is retried and then replaced. See `ResponseProbe`.
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { type GoRoute, goRouteOf } from "./catalogue";
import { DEFAULT_GO_MODEL, goHeaders, OPENCODE_GO_BASE } from "./go";
import { resolveGoCredential } from "./credentials";

/** What a turn needs to build its model. Everything is passed in, so a test
 *  drives a local server and never the real API. */
export type AgentModelInput = {
  /** The conversation — LangGraph's `thread_id` and the upstream session
   *  header, which are deliberately the same string. */
  threadId: string;
  /** From `agent.json`; absent means `DEFAULT_GO_MODEL`. */
  model?: string;
  /**
   * HOW HARD TO THINK — one setting, three spellings on the wire.
   *
   * The three words are Telar's, from `agent.json`, and each route says the
   * same thing in its own API's vocabulary: `reasoning_effort` on
   * chat/completions, an Anthropic `thinking` budget on `/messages`,
   * `reasoning: { effort }` on `/responses`. See `EFFORT_ON` below.
   *
   * ABSENT MEANS THE PARAMETER IS NOT SENT AT ALL, on every route, which is not
   * the same as sending a default.
   */
  effort?: "low" | "medium" | "high";
  /** `<engineRoot>/agent` — rung 1 of the key ladder reads `credentials.json`
   *  inside it. Absent in a test that means to reach no key at all. */
  agentDir?: string;
  /** Rung 3, injected so a test never reads a real home directory. */
  readCliKey?: () => string | undefined;
  /** Overridden by tests to point at a local server. */
  base?: string;
  /** The transport, injected so a test can watch the socket rather than the
   *  configuration. Wrapped either way — see the header. */
  fetchImpl?: typeof fetch;
  /** Streaming is on for a person watching a turn and off for a smoke that
   *  only wants a token count. */
  streaming?: boolean;
  temperature?: number;
  /** A ceiling on the answer. Unset for a turn — the model stops when it has
   *  finished — and set to 1 by the live smoke, which is buying a round trip
   *  rather than an answer. */
  maxTokens?: number;
};

/**
 * NO MESSAGE LEAVES HERE WITH A `name` ON IT (#549).
 *
 * The runtime stopped putting one on its tool results, which is the actual fix;
 * this is the belt to that pair of braces, in the one layer below anything the
 * client library can decide. OpenCode Go proxies some of its models to an
 * Anthropic-shaped upstream that rejects the field outright — `400 … messages[7]:
 * "name" is not supported by this endpoint` — and the cost of learning that again
 * is a person's conversation dying mid-turn on the first tool call. A future
 * `@langchain/openai` that starts inferring a name from a tool call, or a second
 * caller in this repo that sets one, is then a no-op rather than an outage.
 *
 * IT REWRITES NOTHING IT DOES NOT HAVE TO. A body that is not a JSON string, is
 * not an object, has no `messages` array, or has no `name` anywhere in it comes
 * back byte-identical — the request the library built is the request that goes,
 * unless the one field is there. Nothing is logged: a request body is the
 * conversation, and the wrapper's business is the envelope.
 */
function withoutMessageNames(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;
  let found = false;
  const stripped = messages.map((message) => {
    if (typeof message !== "object" || message === null || !("name" in message)) return message;
    found = true;
    const { name: _name, ...rest } = message as Record<string, unknown>;
    return rest;
  });
  return found ? JSON.stringify({ ...(parsed as Record<string, unknown>), messages: stripped }) : body;
}

/**
 * THE CACHE BREAKPOINTS THE ANTHROPIC SHAPE NEEDS, AND ONLY IT (#563 item 3).
 *
 * ── WHY THIS IS A BODY REWRITE AND NOT A RUNTIME SETTING ────────────────────
 * The runtime does not know the route, and this file's header is the promise
 * that it never has to. `cache_control` is a field of ONE of the three wire
 * formats: the chat and `/responses` routes have no such parameter at all —
 * there, caching is the provider's own, automatic, and it depends entirely on
 * the prefix being byte-identical between calls (see `agent-prefix.test.ts`,
 * which measures that it is). So a `SystemMessage` built with cache blocks in
 * `runtime.ts` would be a request shape invented for one endpoint and sent to
 * three, and the two that do not take it would have had their bytes changed for
 * nothing — which is the one thing automatic caching cannot survive.
 *
 * SO IT IS APPLIED WHERE `withoutMessageNames` IS APPLIED, for the same stated
 * reason: this wrapper is the last layer that is still ours, and it is the only
 * one that sees the finished body. It is GATED ON SHAPE rather than on a route
 * name, exactly as its sibling is — a body with a top-level `system` AND a
 * `messages` array is the Anthropic shape and nothing else is. Chat/completions
 * carries its system prompt as `messages[0]` and has no top-level `system`;
 * `/responses` carries `input` rather than `messages`. A body that is not that
 * shape comes back byte-identical.
 *
 * ── THREE BREAKPOINTS, AND THE FIRST IS THE ONE THAT PAYS ───────────────────
 * Anthropic caches the prefix UP TO each breakpoint and allows four. The prompt
 * order is tools → system → messages, so:
 *
 *   1. THE LAST TOOL. The bound tool array is 13,953 characters and is resent on
 *      every lap of every turn — by far the largest fixed block. A breakpoint
 *      here is what keeps it cached when the SYSTEM block changes, and the
 *      system block changes on every turn: the standing state is rewritten by
 *      `remember` and the digest is rebuilt per turn. With only a system
 *      breakpoint, one `remember` call would cost the tools their cache too.
 *   2. THE SYSTEM BLOCK, which adds the briefing, the orientation, the standing
 *      state and the digest to the cached prefix for the laps within one turn.
 *   3. THE LAST MESSAGE, which extends the prefix over the conversation so far.
 *      It moves every lap, which is the point: the cache is prefix-based, so a
 *      breakpoint that advances is one that keeps covering more.
 *
 * ── WHAT IT REFUSES TO MARK ─────────────────────────────────────────────────
 * An empty text block (Anthropic rejects `cache_control` on one) and anything
 * that is not a block it can safely carry the field on. A block that is already
 * marked is left alone rather than marked twice.
 */
function withAnthropicCaching(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;
  const request = parsed as Record<string, unknown>;
  // THE SHAPE TEST, and it is the whole route branch. See the note above.
  if (!("system" in request) || !Array.isArray(request.messages)) return body;

  let marked = false;
  const ephemeral = { type: "ephemeral" as const };
  /** A text block carrying the breakpoint, or the block unchanged when it
   *  cannot take one. Never marks twice and never marks an empty string. */
  const mark = (block: unknown): unknown => {
    if (typeof block === "string") {
      if (!block.trim()) return block;
      marked = true;
      return { type: "text", text: block, cache_control: ephemeral };
    }
    if (!block || typeof block !== "object") return block;
    const record = block as Record<string, unknown>;
    if ("cache_control" in record) return block;
    if (record.type === "text" && typeof record.text === "string" && !record.text.trim()) return block;
    marked = true;
    return { ...record, cache_control: ephemeral };
  };
  /** The LAST element marked, the rest untouched — a breakpoint is a position,
   *  and marking every block would spend four of them on one field. */
  const markLast = (value: unknown): unknown => {
    if (typeof value === "string") return value.trim() ? [mark(value)] : value;
    if (!Array.isArray(value) || value.length === 0) return value;
    const out = [...value];
    out[out.length - 1] = mark(out[out.length - 1]);
    return out;
  };

  const system = markLast(request.system);
  // 1 — the last tool, so the largest block survives a system block that moved.
  const tools = Array.isArray(request.tools) && request.tools.length > 0 ? (markLast(request.tools) as unknown[]) : request.tools;
  // 3 — the last message, on its last content block.
  const messages = [...(request.messages as unknown[])];
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last && typeof last === "object") {
    const record = last as Record<string, unknown>;
    const content = markLast(record.content);
    if (content !== record.content) messages[lastIndex] = { ...record, content };
  }

  return marked ? JSON.stringify({ ...request, system, ...(tools === undefined ? {} : { tools }), messages }) : body;
}

/**
 * THE ERROR A MISSING KEY PRODUCES.
 *
 * Its own class so the route layer can answer 409 with an actionable sentence
 * rather than letting a 500 reach a settings pane that then has nothing to say.
 * The message names all three rungs, because "no key" is ambiguous on a machine
 * where the CLI is signed in but Telar's own field is empty.
 */
export class AgentCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCredentialError";
  }
}

/**
 * THE ERROR A PROVIDER THAT ANSWERED NOTHING PRODUCES (#710).
 *
 * Its own class for the same reason `AgentCredentialError` is one: "the model
 * said nothing" is a DIFFERENT fact from "the model refused", and a caller that
 * wants to tell them apart should not have to read a sentence to do it.
 */
export class AgentEmptyAnswerError extends Error {
  /** The id that was asked — the first thing a bug report needs. */
  readonly model: string;
  /** Which of Go's three endpoints it was asked on. */
  readonly route: GoRoute;
  /** The HTTP status the call came back with, when one was seen. Present means
   *  the request SUCCEEDED and the body was the problem. */
  readonly status: number | undefined;
  constructor(message: string, detail: { model: string; route: GoRoute; status: number | undefined; cause?: unknown }) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = "AgentEmptyAnswerError";
    this.model = detail.model;
    this.route = detail.route;
    this.status = detail.status;
  }
}

/**
 * WHAT THE LAST RESPONSE WAS, AND NOTHING ABOUT WHAT WAS IN IT (#710).
 *
 * ── WHY THE WRAPPER RECORDS RATHER THAN RAISES ──────────────────────────────
 * #710 proposed throwing from the `fetch` wrapper, since it is the one layer
 * that sees every response. MEASURED, that is the one thing the wrapper must
 * NOT do: `openai@7.15.0` treats ANY error thrown from `fetch` as a connection
 * failure, and `client.js` retries it — seven attempts over more than twenty
 * seconds against a local stub — and then throws `APIConnectionError:
 * Connection error.`, carrying the real message only as `.cause`. A sentence
 * naming the model and the route would have been replaced by a slower, vaguer
 * one than the `TypeError` it was written to improve on.
 *
 * So the wrapper writes down the ENVELOPE and lets the call proceed, and the
 * model class below is what raises — at a throw site no SDK retries.
 *
 * ── AND IT NEVER TOUCHES THE BODY ───────────────────────────────────────────
 * Only the status line and two headers, which is both a privacy rule and a
 * correctness one. A response body is the model's answer and reading it here
 * would consume the stream every turn depends on; `Content-Length` answers "how
 * big" without a single byte being read. NOTHING FROM THE REQUEST IS RECORDED —
 * no headers, no body — so a credential cannot reach a message built from this.
 *
 * ── IT IS THE LAST RESPONSE, NOT THIS CALL'S ────────────────────────────────
 * One probe per client, so two overlapping calls on one instance share it. That
 * is deliberate and it is safe HERE: it is read only after a call has already
 * failed, to add detail to a sentence, and the failure itself is decided by the
 * result rather than by this. The status is what gates re-description, and a
 * turn that got a 4xx never reaches that path at all — the SDK raised its own
 * error long before.
 */
type ResponseProbe = { status?: number; contentType?: string | null; length?: string | null };

/** `POST /chat/completions` and friends — the route in the words of the URL it
 *  is, rather than this file's internal name for it. */
function endpointOf(route: GoRoute): string {
  switch (route) {
    case "messages":
      return "POST /messages";
    case "responses":
      return "POST /responses";
    case "chat":
      return "POST /chat/completions";
    case "unknown":
      // `agentChatModel` sends an unrecognised id to the chat client — see its
      // note. Saying so is the point: the route is a GUESS this build made.
      return "POST /chat/completions (an id this build has no route for, sent to the chat client)";
  }
}

/**
 * THE SENTENCE #710 IS ACTUALLY FOR.
 *
 * It names the four things the `TypeError` did not: the model id, the route,
 * that the call SUCCEEDED at the HTTP level, and that what came back carried no
 * answer. The original error is both quoted and attached as `cause` — quoted
 * because `generations[0][0].message` is the string somebody will paste into a
 * search box, and this issue is what they should find.
 *
 * THE BODY IS DESCRIBED, NEVER QUOTED. A 200 that is not a completion is often
 * a proxy's error page, and an error page is exactly the kind of document that
 * echoes a request header back. Its type and size say what a person needs —
 * thirteen bytes of `application/json` is a gateway, not a truncated answer —
 * and neither can carry a key.
 */
function emptyAnswerError(context: EmptyAnswerContext, cause: unknown): AgentEmptyAnswerError {
  const { model, route, probe } = context;
  const http =
    probe.status === undefined
      ? "No HTTP response was recorded for it"
      : `It answered HTTP ${probe.status} (${probe.contentType ?? "no content-type"}${probe.length ? `, ${probe.length} bytes` : ""}) and the body carried no completion`;
  const quoted = cause instanceof Error ? ` Underlying: ${cause.name}: ${cause.message}` : "";
  return new AgentEmptyAnswerError(
    `The model returned no answer. Telar asked \`${model}\` on the ${route} route (${endpointOf(route)}). ` +
      `${http} — the call SUCCEEDED at the HTTP level and came back with nothing. ` +
      `A 4xx or 5xx would have named a reason; a 200 that is not a completion comes from something in the chain that is not the model — a proxy, a gateway, or an error page served as JSON.${quoted}`,
    { model, route, status: probe.status, ...(cause === undefined ? {} : { cause }) },
  );
}

/** What a model needs to describe its own silence. */
type EmptyAnswerContext = { model: string; route: GoRoute; probe: ResponseProbe };

/**
 * WHEN AN ERROR IS RE-DESCRIBED, AND WHEN IT IS LEFT ALONE.
 *
 * THE GATE IS THE STATUS, and it is the whole rule: re-describe only what
 * followed a 2xx. A 4xx or 5xx already raised a real `APIError` naming the
 * reason — #710 says so explicitly and it is right — and a connection failure
 * records no response at all. Both come through here untouched, because
 * replacing a good error with a guess is the defect this function exists to
 * stop, pointed the other way.
 *
 * WHAT IS LEFT IS THE 200-SHAPED-WRONG CASE, where every client library on this
 * path dies reading a field of `undefined` three frames down. MEASURED across
 * all three routes, streaming and not, against a stub answering `200
 * {"ok":true}`: six distinct `TypeError`s, none naming a model, a route or a
 * provider. They are all the same defect and this gives them all one sentence.
 */
function describing(context: EmptyAnswerContext, error: unknown): unknown {
  if (context.probe.status === undefined || context.probe.status < 200 || context.probe.status >= 300) return error;
  return emptyAnswerError(context, error);
}

/**
 * A RESULT WITH NO GENERATIONS IS A FAILURE, AND IT IS THE ONE #710 NAMED.
 *
 * `BaseChatModel.invoke` reads `generations[0][0].message` without looking, so
 * an empty array becomes `undefined is not an object` one frame above anything
 * that knows what was asked. Checked HERE, inside the model, where the id and
 * the route are still in scope.
 */
function nonEmpty(context: EmptyAnswerContext, result: ChatResult): ChatResult {
  if (!result?.generations?.length) throw emptyAnswerError(context, undefined);
  return result;
}

/**
 * ── THE TWO CLIENTS, TAUGHT TO SAY WHEN THEY GOT NOTHING (#710) ─────────────
 *
 * ── WHY A SUBCLASS AND NOT A WRAPPER AROUND `invoke` ────────────────────────
 * `invoke` is not the seam: the runtime binds tools and streams, so a turn
 * reaches this model as `bindTools(...).stream(...)` as often as it does
 * `invoke`. `_generate` and `_streamResponseChunks` are the two methods ALL of
 * those funnel through — `bindTools` returns a binding around this same
 * instance — so overriding them covers every caller, including ones not written
 * yet. `lc_name` is deliberately NOT overridden, so these serialise as the
 * classes they extend and nothing about a checkpoint changes.
 *
 * TWO CLASSES AND NOT THREE, because `/responses` is `ChatOpenAI` in another
 * mode — the same object with `useResponsesApi`, which is exactly why this file
 * builds it from the same class.
 *
 * BOTH OVERRIDES DO THE SAME TWO THINGS: hand a failure to `describing`, which
 * replaces it only when a 2xx preceded it, and treat an EMPTY success as a
 * failure. The second is the half that matters — a stream that yields no chunks
 * and a result with no generations are both "the provider said nothing", and
 * neither throws anything on its own.
 */
class DescribingChatOpenAI extends ChatOpenAI {
  readonly #context: EmptyAnswerContext;
  constructor(fields: ConstructorParameters<typeof ChatOpenAI>[0] & { telar: EmptyAnswerContext }) {
    const { telar, ...rest } = fields;
    super(rest);
    this.#context = telar;
  }
  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    try {
      return nonEmpty(this.#context, await super._generate(messages, options, runManager));
    } catch (error) {
      throw error instanceof AgentEmptyAnswerError ? error : describing(this.#context, error);
    }
  }
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    let chunks = 0;
    try {
      for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
        chunks += 1;
        yield chunk;
      }
    } catch (error) {
      throw describing(this.#context, error);
    }
    // ONLY ON AN EXHAUSTED STREAM. A consumer that breaks early returns through
    // the generator rather than falling out of the loop, so a turn that stopped
    // reading is never reported as a provider that stopped answering.
    if (chunks === 0) throw emptyAnswerError(this.#context, undefined);
  }
}

class DescribingChatAnthropic extends ChatAnthropic {
  readonly #context: EmptyAnswerContext;
  constructor(fields: ConstructorParameters<typeof ChatAnthropic>[0] & { telar: EmptyAnswerContext }) {
    const { telar, ...rest } = fields;
    super(rest);
    this.#context = telar;
  }
  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    try {
      return nonEmpty(this.#context, await super._generate(messages, options, runManager));
    } catch (error) {
      throw error instanceof AgentEmptyAnswerError ? error : describing(this.#context, error);
    }
  }
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    let chunks = 0;
    try {
      for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
        chunks += 1;
        yield chunk;
      }
    } catch (error) {
      throw describing(this.#context, error);
    }
    if (chunks === 0) throw emptyAnswerError(this.#context, undefined);
  }
}

/**
 * ── HOW HARD TO THINK, PER ROUTE ────────────────────────────────────────────
 *
 * Telar offers three words and each API spells them differently. The words are
 * the setting; these are the wire.
 *
 * `/messages` IS THE ONE THAT NEEDS A NUMBER. The Anthropic shape takes a
 * `thinking` BUDGET in tokens rather than a level, so the three words have to
 * be given sizes, and a size invented here is a claim like any other. These are
 * the ones #571 names, and they are chosen to be recognisably a floor, a
 * working depth and a ceiling rather than to be tuned — the model spends up to
 * the budget and stops, so a generous high costs nothing on a turn that did not
 * need it. Anthropic's own floor for the field is 1024, and `low` clears it.
 *
 * THE OTHER TWO TAKE THE WORD ITSELF, which is why there is no table for them.
 */
const THINKING_BUDGET: Record<NonNullable<AgentModelInput["effort"]>, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
};

/**
 * THE CEILING `/messages` REQUIRES, AND THE TWO OTHERS DO NOT.
 *
 * `max_tokens` is optional on chat/completions and on `/responses`, and this
 * factory omits it there on purpose (see `maxTokens`): a turn ends when the
 * model has finished. The Anthropic shape makes it REQUIRED — a request without
 * one is a 400 — so a number has to exist, and the honest place for it is here
 * rather than inside a client library's per-model default table, which has no
 * row for `union-alpha` and falls back to 4096.
 *
 * ── IT IS PINNED FROM BOTH SIDES, WHICH IS WHY IT IS NOT A ROUND 32k ─────────
 * BELOW it: the `high` budget is 16k and Anthropic's rule is
 * `budget_tokens < max_tokens`, so a ceiling that only just cleared 16k would
 * buy a turn that thought and then had nothing left to say. 20k leaves 4k of
 * answer, which is a great deal more than a lap of an agent turn spends — the
 * visible half of one is a sentence and some tool calls.
 *
 * ABOVE it: `@anthropic-ai/sdk` REFUSES a non-streaming request whose
 * `max_tokens` implies more than ten minutes, and its arithmetic
 * (`60min × max_tokens / 128000`) puts that cutoff at 21,333 — measured, 21,333
 * is accepted and 32,000 throws `Streaming is required for operations that may
 * take longer than 10 minutes` before anything reaches the socket. Turns stream
 * and would never have noticed; the live smoke does not, and neither would any
 * future caller that just wants one round trip.
 */
const MESSAGES_MAX_TOKENS = 20_000;

/**
 * THE `/v1` THE ANTHROPIC CLIENT INSISTS ON ADDING ITSELF.
 *
 * `OPENCODE_GO_BASE` ends in `/v1` because that is the base Go publishes and
 * because `@langchain/openai` joins its paths straight onto whatever it is
 * given: `…/zen/go/v1` + `/chat/completions`. `@anthropic-ai/sdk` does NOT work
 * that way — it owns the version segment and posts to `/v1/messages` on top of
 * the configured base, so handing it Go's base verbatim asks
 * `…/zen/go/v1/v1/messages`, which is a 404 nobody would connect to this line.
 *
 * SO ONE TRAILING `/v1` IS TAKEN OFF, AND ONLY IF IT IS THERE. A base without
 * one is left alone, which is what a test server pointed at a bare host is and
 * what a future base that drops the segment would be. The regex is anchored and
 * takes at most one segment: a path that happens to contain `v1` elsewhere is
 * not this function's business.
 *
 * `agent-model.test.ts` asserts the resulting path against a base shaped like
 * the real one, because "the URL was built correctly" is not a fact the
 * factory's return value can be asked about.
 */
export function anthropicBaseOf(base: string): string {
  return base.replace(/\/v1\/?$/, "");
}

/**
 * The model this turn talks to — the client for its route.
 *
 * THROWS RATHER THAN FALLING BACK when there is no key. A turn that quietly ran
 * against something else would put an answer in front of a person that came
 * from a provider they did not choose.
 *
 * AN UNKNOWN ROUTE GETS THE CHAT CLIENT, which is `AgentModel.supported`'s own
 * rule one layer up: an id this build has not been told about is most likely a
 * new sibling on Go's OpenAI-compatible base, and letting somebody try one that
 * might 400 beats locking them out of one that probably works.
 */
export function agentChatModel(input: AgentModelInput): BaseChatModel {
  const credential = resolveGoCredential({
    ...(input.agentDir ? { agentDir: input.agentDir } : {}),
    ...(input.readCliKey ? { readCliKey: input.readCliKey } : {}),
  });
  if (!credential) {
    throw new AgentCredentialError(
      "Telar's Agent needs an OpenCode Go key. Paste one in Settings, or set OPENCODE_API_KEY, or sign the OpenCode CLI in.",
    );
  }
  /**
   * `goHeaders` BUILDS THEM, AND THE CREDENTIAL IS LEFT TO THE CLIENT.
   *
   * Each library takes the key as `apiKey` and sets its own family's header —
   * `Authorization: Bearer` for `ChatOpenAI`, `x-api-key` for `ChatAnthropic` —
   * and those are exactly the two headers the measurement in the file header
   * found each route wanting. Forcing one here would send it twice on the route
   * it fits and send the wrong one on the route it does not. Everything else
   * `goHeaders` decides — the agent string, the session header, `Accept` — is
   * forced, because those are the promises `go.ts` makes to the service.
   */
  const { Authorization: _authorization, ...forced } = goHeaders({ sessionId: input.threadId });
  const transport = input.fetchImpl ?? fetch;
  /** Filled on the way back, read only when a call has already failed — see
   *  `ResponseProbe` for why this records instead of raising. */
  const probe: ResponseProbe = {};
  const withTelarHeaders: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(forced)) headers.set(name, value);
    // ONE TAKES A FIELD OFF, THE OTHER PUTS ONE ON, and both are gated on the
    // body's SHAPE rather than on a route — see each function's note. The strip
    // runs first so the cache pass never marks a block on a message that was
    // about to be rewritten anyway.
    const response = await transport(url, { ...init, headers, body: withAnthropicCaching(withoutMessageNames(init?.body)) });
    // THE ENVELOPE ONLY, AND THE RESPONSE IS HANDED BACK UNTOUCHED — not
    // cloned, not read, not buffered. Three header reads cost a streaming turn
    // nothing, which is the entire reason this is the shape it is.
    probe.status = response.status;
    probe.contentType = response.headers.get("content-type");
    probe.length = response.headers.get("content-length");
    return response;
  };
  /** The two facts every message this client can raise is built from. */
  const telar = (model: string): EmptyAnswerContext => ({ model, route: goRouteOf(model), probe });

  /**
   * THE NAMED DEFAULT, NOT THE CHECKED ONE — deliberately (#551).
   *
   * `agent/catalogue.ts`'s `defaultAgentModel` checks `DEFAULT_GO_MODEL`
   * against what Go is serving on a route this client speaks, and the picker
   * reads it. Doing that HERE would mean a `GET /models` on every turn: a
   * network round trip, and a new way for a turn to fail, bought against a case
   * that has never happened. The picker warns when what will run is unreachable
   * and offers the switch in one press; this stays a constant.
   */
  const model = input.model?.trim() || DEFAULT_GO_MODEL;
  const base = input.base ?? OPENCODE_GO_BASE;

  if (goRouteOf(model) === "messages") {
    /**
     * THE CEILING IS DECIDED BEFORE THE BUDGET, because the budget depends on
     * it. `budget_tokens` must be strictly under `max_tokens` or the request is
     * a 400, so a caller who asked for a tiny answer gets no thinking rather
     * than an error: the live smoke buys a single token to prove a round trip
     * and has no business paying for 16k of reasoning to do it. A real turn
     * sets no ceiling, lands on `MESSAGES_MAX_TOKENS`, and every budget fits.
     */
    const maxTokens = input.maxTokens ?? MESSAGES_MAX_TOKENS;
    const budget = input.effort ? THINKING_BUDGET[input.effort] : undefined;
    const thinking = budget !== undefined && budget < maxTokens ? { type: "enabled" as const, budget_tokens: budget } : undefined;
    return new DescribingChatAnthropic({
      telar: telar(model),
      apiKey: credential.key,
      model,
      /**
       * TEMPERATURE AND THINKING ARE MUTUALLY EXCLUSIVE HERE, and the library
       * says so out loud: `temperature is not supported when thinking is
       * enabled` is thrown before the request is built. The two other routes
       * have no such rule, so the Agent's usual 0 stands there.
       *
       * THINKING WINS WHEN BOTH ARE IN PLAY. A person who set an effort asked
       * for the reasoning; a temperature of 0 is this factory's own default
       * that nobody typed, and dropping a default to honour a setting is the
       * right way round. Anthropic's own answer for a thinking request is a
       * temperature of 1, which is what omitting it sends.
       */
      ...(thinking ? {} : { temperature: input.temperature ?? 0 }),
      streaming: input.streaming ?? true,
      streamUsage: true,
      maxTokens,
      ...(thinking ? { thinking } : {}),
      anthropicApiUrl: anthropicBaseOf(base),
      /**
       * `authToken: null` IS A CREDENTIAL LEAK, CLOSED (#571).
       *
       * MEASURED, and it is the reason this line exists rather than a
       * precaution. `@anthropic-ai/sdk` resolves `authToken` from
       * `ANTHROPIC_AUTH_TOKEN` in the ambient environment whenever the caller
       * passes `undefined`, and `@langchain/anthropic` passes `undefined`. On a
       * machine with that variable set — a developer's, or anyone running Telar
       * beside a Claude tool — the very first `/messages` request carried
       * `Authorization: Bearer sk-…` for SOMEBODY ELSE'S ANTHROPIC ACCOUNT,
       * alongside the `x-api-key` that is the credential actually meant for this
       * call. It is picked up by an env read, so nothing in this file or in
       * `credentials.ts` would have shown it; the test below caught it because
       * it asserts from the socket, and it asserted the ABSENCE of a header.
       *
       * `null` is the SDK's own "there is none, do not go looking" — distinct
       * from `undefined`, which is what invites the env read. The Agent's key
       * ladder is `credentials.ts` and has exactly three rungs; a fourth one
       * reached through a client library's convenience is not one of them.
       */
      clientOptions: { fetch: withTelarHeaders, authToken: null },
    });
  }

  if (goRouteOf(model) === "responses") {
    return new DescribingChatOpenAI({
      telar: telar(model),
      apiKey: credential.key,
      model,
      /**
       * NO TEMPERATURE UNLESS SOMEBODY ASKED FOR ONE — measured (#571).
       *
       * The live smoke over all five `/responses` ids found `gpt-5.6-luna`
       * answering `400 … Unsupported parameter: 'temperature' is not supported
       * with this model.` The other four accepted it, which is what makes this
       * worth a comment: the route is reasoning models, and a reasoning model
       * refusing a sampling knob is the rule rather than that one id's quirk.
       *
       * THE RULE IS THE SAME ONE THE `/messages` BRANCH APPLIES TO THINKING: a
       * default THIS FACTORY invented must never be the thing that costs
       * somebody a model. The Agent's 0 is not a setting anybody typed — there
       * is no temperature field in `agent.json` — so on this route it is simply
       * not sent, and a caller who passes one explicitly still gets it (and
       * gets the 400 they asked for, on the id that refuses).
       */
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      streaming: input.streaming ?? true,
      streamUsage: true,
      /** THE SAME CLIENT, THE OTHER ENDPOINT — `useResponsesApi` moves
       *  `@langchain/openai` onto `POST /responses` and onto that path's own
       *  field names. */
      useResponsesApi: true,
      /**
       * EFFORT AS `reasoning: { effort }` — AND THROUGH `modelKwargs` AGAIN.
       *
       * ── THE SAME TRAP THE CHAT ROUTE FELL INTO, TWO FIELDS OVER ─────────────
       * `ChatOpenAI` has BOTH a `reasoning` field and a `reasoningEffort` field,
       * and on 1.5.13, against a local server, NEITHER reaches a `/responses`
       * body: a client configured with `reasoning: { effort: "high" }` sent
       * `{ input, model, temperature, stream, text }` and nothing else, and so
       * did one configured with `reasoningEffort: "high"`. The same client with
       * `modelKwargs: { reasoning: { effort: "high" } }` sent it verbatim.
       *
       * That is the identical failure mode the note on the chat route below
       * describes — a configured setting that silently does nothing — arrived at
       * by the identical method, and it is the third time this file has been
       * paid for asserting from the socket rather than from the configuration.
       * `agent-model.test.ts` watches the wire here for that reason.
       */
      ...(input.effort ? { modelKwargs: { reasoning: { effort: input.effort } } } : {}),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      configuration: { baseURL: base, fetch: withTelarHeaders },
    });
  }

  return new DescribingChatOpenAI({
    telar: telar(model),
    apiKey: credential.key,
    model,
    temperature: input.temperature ?? 0,
    streaming: input.streaming ?? true,
    // Asked for explicitly: without it an OpenAI-compatible stream reports no
    // usage at all, and a turn with no token count is a turn missing from the
    // usage report.
    streamUsage: true,
    /**
     * EFFORT, ONLY WHEN SOMEBODY SET IT — `reasoning_effort` on the wire.
     *
     * ── WHY `modelKwargs` AND NOT `reasoningEffort` ─────────────────────────
     * `ChatOpenAI` HAS a `reasoningEffort` field, and in this version it does
     * NOT reach a chat-completions body: measured against a local server on
     * `@langchain/openai` 1.5.13, a client configured with
     * `reasoningEffort: "high"` sent `{ model, stream, messages }` and nothing
     * else — the field is carried on the Responses API path only. The same
     * client with `modelKwargs: { reasoning_effort: "high" }` sent it verbatim.
     *
     * So the configured field would have been a setting that silently did
     * nothing, which is the worst of the three outcomes: worse than omitting it
     * and saying so, and worse than an error. `agent-model.test.ts` asserts what
     * reached the SOCKET for exactly this reason — the same rule the `User-Agent`
     * header above is tested by, and the second time that rule has paid here.
     *
     * ── WHY `reasoning_effort` IS THE RIGHT NAME ────────────────────────────
     * opencode.ai/docs/go publishes the base URL and the session header and no
     * parameter list, but the endpoint is explicitly OpenAI-compatible, and
     * `reasoning_effort` is that API's field for a reasoning DEPTH. The three
     * values Telar offers are inside the set it accepts. A server that does not
     * honour the field ignores an unknown key, which is the same behaviour as
     * not sending it.
     *
     * ── OMITTED RATHER THAN DEFAULTED ───────────────────────────────────────
     * A model with no reasoning mode is served today by a request that does not
     * mention reasoning; sending `medium` on its behalf would change what every
     * existing conversation asks for, and on a strict server it is a 400 where
     * there was an answer. An unset setting sends nothing.
     */
    ...(input.effort ? { modelKwargs: { reasoning_effort: input.effort } } : {}),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    configuration: { baseURL: base, fetch: withTelarHeaders },
  });
}
