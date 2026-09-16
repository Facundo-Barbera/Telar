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
    return transport(url, { ...init, headers });
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
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    configuration: { baseURL: input.base ?? OPENCODE_GO_BASE, fetch: withTelarHeaders },
  });
}
