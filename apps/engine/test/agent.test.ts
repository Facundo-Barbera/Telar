/**
 * The structured-agent seam.
 *
 * MOST OF THIS FILE ASSERTS WHAT A STRUCTURED CALL CANNOT DO. The call runs at
 * `bypassPermissions` with no human attached, so every claim in `agent.ts`'s
 * header about its reach is load-bearing rather than descriptive — and a claim
 * nothing asserts is a claim that drifts. The wall is a pure function precisely
 * so this file can read it without a provider and without spending a cent.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  assertWall,
  isRateLimit,
  NEVER_TOOLS,
  READ_ONLY_TOOLS,
  retryAfterFrom,
  structuredAgent,
  type ClaudeAgentSdk,
} from "../src/agent";

const SCHEMA = z.object({
  fixed: z.string(),
  acceptance: z.array(z.string()),
});

/**
 * A fake SDK that records the options it was handed and replays a scripted
 * conversation. `emit` is what the model "calls" — passing `undefined` models a
 * turn that ended without ever emitting, which is the failure the real thing
 * produces on a turn limit, a cancel, or a provider hiccup.
 */
function fakeSdk(script: { emit?: unknown; messages?: Array<Record<string, unknown>>; throws?: Error } = {}) {
  const seen: { prompt?: string; options?: Record<string, unknown> } = {};
  let emitHandler: ((input: unknown) => Promise<unknown>) | undefined;

  const sdk: ClaudeAgentSdk = {
    createSdkMcpServer: (input) => ({ __server: input.name, tools: input.tools }),
    tool: (name, description, shape, handler) => {
      emitHandler = handler as (input: unknown) => Promise<unknown>;
      return { name, description, shape };
    },
    async *query(input) {
      seen.prompt = input.prompt;
      seen.options = input.options;
      if (script.throws) throw script.throws;
      if (script.emit !== undefined) await emitHandler?.(script.emit);
      for (const message of script.messages ?? [{ type: "result", subtype: "success" }]) yield message;
    },
  };
  return { sdk, seen };
}

const deps = (sdk: ClaudeAgentSdk) => ({ loadSdk: async () => sdk, resolveExecutable: () => "/usr/local/bin/claude" });

describe("the wall", () => {
  test("a call that asks for nothing gets read-only reach and nothing else", () => {
    const wall = assertWall(undefined);
    expect(wall.tools).toEqual([...READ_ONLY_TOOLS]);
    expect(wall.dropped).toEqual([]);
  });

  test("every writing and spawning tool is denied by name, whatever the caller asked for", () => {
    // The deny list is unconditional: it does not depend on what was requested,
    // because its job is to beat an allow rule introduced somewhere this file
    // cannot see.
    for (const requested of [undefined, ["Read"], ["Read", "Write"], [...NEVER_TOOLS]]) {
      expect(assertWall(requested).disallowedTools).toEqual([...NEVER_TOOLS]);
    }
  });

  test("asking for a forbidden tool drops it and says so rather than refusing the call", () => {
    // Reported, not thrown. An overnight run nobody is watching should lose the
    // tool, not the pass — but the mistake has to be visible.
    const wall = assertWall(["Read", "Bash", "Write", "Grep"]);
    expect(wall.tools).toEqual(["Read", "Grep"]);
    expect(wall.dropped).toEqual(["Bash", "Write"]);
    expect(wall.allowedTools).not.toContain("Bash");
  });

  test("`Agent` is dropped, so a structured call cannot spawn a child that outlives its scope", () => {
    expect(assertWall(["Read", "Agent"]).dropped).toContain("Agent");
    expect(NEVER_TOOLS).toContain("Agent");
  });

  test("availability lists built-ins only; the emit tool rides the approval list", () => {
    // The SDK rejects an mcp__ name in `tools` — it is not a built-in — so the
    // two lists genuinely differ rather than being one list spelled twice.
    const wall = assertWall(["Read", "mcp__telar__spool_list_items"]);
    expect(wall.tools).toEqual(["Read"]);
    expect(wall.allowedTools).toEqual(["Read", "mcp__telar__spool_list_items", "mcp__out__emit_result"]);
  });

  test("the emit tool is always approved — without it the call cannot answer at all", () => {
    for (const requested of [undefined, ["Read"], []]) {
      expect(assertWall(requested).allowedTools).toContain("mcp__out__emit_result");
    }
  });
});

describe("the query it builds", () => {
  test("bypassPermissions never travels without the tool restriction that makes it safe", async () => {
    // THE ONE ASSERTION THIS FILE EXISTS FOR. The permission mode is only
    // defensible because availability is restricted alongside it; an option
    // added later that sets one without the other has to fail here.
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(seen.options?.permissionMode).toBe("bypassPermissions");
    expect(seen.options?.tools).toEqual([...READ_ONLY_TOOLS]);
    expect(seen.options?.disallowedTools).toEqual([...NEVER_TOOLS]);
  });

  test("it discovers no ambient config, so a repo's own settings cannot widen it", async () => {
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(seen.options?.settingSources).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });

  test("only the `out` server is mounted — a structured call reaches no Telar capability", async () => {
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(Object.keys(seen.options?.mcpServers as object)).toEqual(["out"]);
  });

  test("the model and the turn ceiling are stated, never left to a default nobody chose", async () => {
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(seen.options?.model).toBe("sonnet");
    expect(seen.options?.maxTurns).toBe(40);
  });

  test("the prompt ends with the instruction that makes the forced result reachable", async () => {
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("READ THIS", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(seen.prompt).toStartWith("READ THIS");
    expect(seen.prompt).toContain("emit_result exactly once");
  });

  test("the resolved executable is passed, so a packaged build does not fall back to a binary it lacks", async () => {
    const { sdk, seen } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(seen.options?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });
});

describe("what comes back", () => {
  test("an emitted result is parsed and returned", async () => {
    const { sdk } = fakeSdk({ emit: { fixed: "a brief", acceptance: ["one", "two"] } });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "test" }, deps(sdk));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ fixed: "a brief", acceptance: ["one", "two"] });
  });

  test("a finished turn that never emitted is a failure, never an empty success", async () => {
    // Success is inferred from the EMIT and nothing else. A turn that ran out of
    // turns ends its loop exactly like a good one.
    const { sdk } = fakeSdk({});
    const result = await structuredAgent("go", { schema: SCHEMA, label: "interpret" }, deps(sdk));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("no-result");
      expect(result.reason).toContain("interpret");
      expect(result.reason).toContain("nothing was written");
    }
  });

  test("a result that does not fit the schema is its own failure, not a silent pass", async () => {
    // The SDK validates against the shape it was given; this module re-parses
    // anyway, because a check performed by someone else's code is not a
    // guarantee this one can make.
    const { sdk } = fakeSdk({ emit: { fixed: 42, acceptance: "not an array" } });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "interpret" }, deps(sdk));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("malformed");
      // The sentence names the offending field, because the caller shows this
      // to a human who has to decide whether to retry.
      expect(result.reason).toContain("fixed");
    }
  });

  test("the three failures are distinguishable, so a caller can say three different things", async () => {
    const noResult = await structuredAgent("go", { schema: SCHEMA, label: "t" }, deps(fakeSdk({}).sdk));
    const malformed = await structuredAgent("go", { schema: SCHEMA, label: "t" }, deps(fakeSdk({ emit: {} }).sdk));
    const unavailable = await structuredAgent(
      "go",
      { schema: SCHEMA, label: "t" },
      {
        loadSdk: async () => {
          throw new Error("no SDK here");
        },
      },
    );

    expect([noResult, malformed, unavailable].map((r) => (r.ok ? "ok" : r.kind))).toEqual([
      "no-result",
      "malformed",
      "unavailable",
    ]);
  });

  test("a missing Claude is reported with the resolver's own actionable message", async () => {
    const { sdk } = fakeSdk({ emit: { fixed: "x", acceptance: [] } });
    const result = await structuredAgent(
      "go",
      { schema: SCHEMA, label: "interpret" },
      {
        loadSdk: async () => sdk,
        resolveExecutable: () => {
          throw new Error("install Claude Code to run this");
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unavailable");
      expect(result.reason).toContain("install Claude Code");
    }
  });

  test("a cancelled call reports the cancel rather than a provider fault", async () => {
    const abort = new AbortController();
    abort.abort();
    const { sdk } = fakeSdk({ throws: new Error("aborted") });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "t", abort }, deps(sdk));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("aborted");
  });

  test("usage rides back with the answer, because an unattended call has to say what it spent", async () => {
    const { sdk } = fakeSdk({
      emit: { fixed: "x", acceptance: [] },
      messages: [
        {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.0123,
          num_turns: 3,
          usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
        },
      ],
    });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "t" }, deps(sdk));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({
        tokens: { input: 900, output: 120, cacheRead: 40, cacheCreate: 10 },
        costUsd: 0.0123,
        turns: 3,
      });
    }
  });

  test("a provider that reports no usage yields no usage, rather than a fabricated zero", async () => {
    // Absent is not the same as free. A caller totalling a night's spend must be
    // able to tell "cost nothing" from "did not say".
    const { sdk } = fakeSdk({ emit: { fixed: "x", acceptance: [] }, messages: [{ type: "result" }] });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "t" }, deps(sdk));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toBeUndefined();
  });
});

describe("rate limits are their own kind of failure", () => {
  test("the provider's own vocabulary is recognised", () => {
    // A HEURISTIC OVER PROSE, because the SDK surfaces this as a message rather
    // than a typed error. Being wrong in the safe direction costs one night's
    // remaining work; being wrong the other way costs a loop of doomed requests.
    for (const message of [
      "rate limit exceeded",
      "HTTP 429",
      "Too Many Requests",
      "quota exceeded for this organization",
      "usage limit reached",
      "overloaded_error",
    ]) {
      expect(isRateLimit(message), `"${message}" should read as a rate limit`).toBe(true);
    }
  });

  test("an ordinary failure is NOT read as one", () => {
    // The costly direction: a night that stopped on the first malformed answer
    // would leave every other item unworked for no reason.
    for (const message of ["the model finished without emitting a result", "ENOENT", "native CLI binary not found"]) {
      expect(isRateLimit(message), `"${message}" must not read as a rate limit`).toBe(false);
    }
  });

  test("a reset time is read when the provider gives one, in either unit", () => {
    const now = 1_000_000;
    expect(retryAfterFrom("retry-after: 30", now)).toBe(now + 30_000);
    expect(retryAfterFrom("try again in 45s", now)).toBe(now + 45_000);
    // Ten digits is seconds and thirteen is milliseconds — guessing wrong parks
    // the runner for a month or for no time at all.
    expect(retryAfterFrom("resets at 1786800000", now)).toBe(1_786_800_000_000);
    expect(retryAfterFrom("resets at 1786800000000", now)).toBe(1_786_800_000_000);
  });

  test("no reset time is absent, never invented", () => {
    // A runner with no reset waits for its next ordinary trigger. A guessed one
    // would either hammer the provider or idle for hours nobody chose.
    expect(retryAfterFrom("rate limit exceeded", 1_000_000)).toBeUndefined();
  });

  test("a rate-limited call reports its own kind rather than `unavailable`", async () => {
    const { sdk } = fakeSdk({ throws: new Error("429 Too Many Requests; retry-after: 60") });
    const result = await structuredAgent("go", { schema: SCHEMA, label: "t" }, deps(sdk));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("rate-limited");
      expect(result.retryAfter).toBeGreaterThan(Date.now());
      expect(result.reason).toContain("Nothing was written");
    }
  });
});
