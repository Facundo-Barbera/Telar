/**
 * THE AGENT'S MODEL — OpenCode Go through `@langchain/openai` (#531).
 *
 * ── WHY A CLIENT LIBRARY HERE, WHEN `./go.ts` ARGUES AGAINST ONE ────────────
 * `go.ts` uses raw `fetch` and says why: the surface it needs is two
 * OpenAI-compatible endpoints, and a dependency for that is a dependency for
 * its whole tree. Nothing about that has changed — `readOpenCodeGoModels` still
 * uses `fetch` and still should. What changed is the CALLER. A LangGraph node
 * hands its messages to a `BaseChatModel` and gets tool calls back as objects;
 * reimplementing that interface over `fetch` would mean re-deriving streaming
 * deltas, tool-call fragment reassembly and usage metadata into LangChain's own
 * shapes — which is precisely what `@langchain/openai` is, and it is already
 * installed because the graph is.
 *
 * ── THE KEY IS NOT THIS FILE'S BUSINESS ─────────────────────────────────────
 * `resolveGoCredential` answers where a key comes from and nothing here caches,
 * logs or returns one. It is resolved per call for `main-session/driver.ts`'s
 * own reason: a person who pastes a key, or revokes one in the CLI, gets the
 * new answer on their next message rather than on the next restart.
 *
 * ── THE THREE HEADERS, AND WHY `defaultHeaders` IS NOT ENOUGH ───────────────
 * `Authorization`, `User-Agent: telar/<version>` and `x-opencode-session:
 * <threadId>`. They are `goHeaders`' own, read from there rather than spelled
 * again, so the Agent introduces itself exactly as the rest of this engine does
 * and a log on the other side sees one product rather than two.
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
 */
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
   * HOW HARD TO THINK — `reasoning_effort` on the wire, from `agent.json`.
   *
   * ABSENT MEANS THE PARAMETER IS NOT SENT AT ALL, which is not the same as
   * sending a default. See the header note on where this name comes from.
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
 * The model this turn talks to.
 *
 * THROWS RATHER THAN FALLING BACK when there is no key. A turn that quietly ran
 * against something else would put an answer in front of a person that came
 * from a provider they did not choose.
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
   * `goHeaders` BUILDS THEM, AND `Authorization` IS LEFT TO THE CLIENT.
   *
   * `ChatOpenAI` takes the key as `apiKey` and sets that header itself; forcing
   * it here too would send it twice and make the one place it is spelled
   * ambiguous. Everything else `goHeaders` decides — the agent string, the
   * session header, `Accept` — is forced, because those are the promises
   * `go.ts` makes to the service.
   */
  const { Authorization: _authorization, ...forced } = goHeaders({ sessionId: input.threadId });
  const transport = input.fetchImpl ?? fetch;
  const withTelarHeaders: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(forced)) headers.set(name, value);
    return transport(url, { ...init, headers, body: withoutMessageNames(init?.body) });
  };

  return new ChatOpenAI({
    apiKey: credential.key,
    model: input.model?.trim() || DEFAULT_GO_MODEL,
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
    configuration: { baseURL: input.base ?? OPENCODE_GO_BASE, fetch: withTelarHeaders },
  });
}
