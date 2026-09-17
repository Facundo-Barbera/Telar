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
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { goRouteOf } from "./catalogue";
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
  const withTelarHeaders: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(forced)) headers.set(name, value);
    return transport(url, { ...init, headers, body: withoutMessageNames(init?.body) });
  };

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
    return new ChatAnthropic({
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
    return new ChatOpenAI({
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

  return new ChatOpenAI({
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
