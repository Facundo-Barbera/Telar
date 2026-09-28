import { describe, expect, test } from "bun:test";
import { until } from "../../../test/wait";
import { createClaudeDriver, recorder, run } from "../../../test/claude-harness";

// ── the session runtime: one live query per session ──────────────────────────

describe("the session runtime", () => {
  test("two turns of one session share ONE live query — the process outlives the turn", async () => {
    let queryCalls = 0;
    const heard: unknown[] = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
        queryCalls += 1;
        for await (const message of prompt) {
          heard.push(message.message.content);
          yield { type: "assistant", message: { content: [{ type: "text", text: `answer:${heard.length}` }] } };
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    const first = await run(driver, { sessionId: "session_shared" }).result;
    const second = await run(driver, { sessionId: "session_shared", prompt: "second prompt" }).result;
    expect(queryCalls).toBe(1);
    expect(heard).toEqual(["prompt", "second prompt"]);
    expect(first.text).toBe("answer:1");
    expect(second.text).toBe("answer:2");
  });

  test("stop INTERRUPTS the turn; the session survives and answers the next turn", async () => {
    let queryCalls = 0;
    let interrupts = 0;
    let release: (() => void) | undefined;
    const driver = createClaudeDriver(async () => ({
      query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
        const generator = (async function* () {
          queryCalls += 1;
          const input = prompt[Symbol.asyncIterator]();
          // Turn 1: read the prompt, then stay "working" until interrupted.
          await input.next();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          yield { type: "result", subtype: "error_during_execution" };
          // Turn 2, same process: answer normally.
          await input.next();
          yield { type: "assistant", message: { content: [{ type: "text", text: "after stop" }] } };
          yield { type: "result", subtype: "success" };
        })();
        return Object.assign(generator, {
          interrupt: async () => {
            interrupts += 1;
            release?.();
          },
        });
      },
    }) as never);

    const controller = new AbortController();
    const sink = recorder();
    const firstTurn = driver.run({
      prompt: "prompt",
      sessionId: "session_stoppable",
      cwd: "/tmp",
      signal: controller.signal,
      onObservations: sink.onObservations,
    });
    // Wait until the fake is genuinely mid-turn, then stop it.
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("the human pressed stop"));
    await expect(firstTurn).rejects.toThrow("the human pressed stop");
    expect(interrupts).toBe(1);

    const second = await run(driver, { sessionId: "session_stoppable", prompt: "carry on" }).result;
    expect(second.text).toBe("after stop");
    expect(queryCalls).toBe(1);
  });

  test("a turn claimed while the stopped one is still parked WAITS for it — one pump per session", async () => {
    let release: (() => void) | undefined;
    const driver = createClaudeDriver(async () => ({
      query({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
        const generator = (async function* () {
          const input = prompt[Symbol.asyncIterator]();
          await input.next();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          yield { type: "result", subtype: "error_during_execution" };
          await input.next();
          yield { type: "assistant", message: { content: [{ type: "text", text: "after stop" }] } };
          yield { type: "result", subtype: "success" };
        })();
        // An interrupt that takes a while to be honoured.
        return Object.assign(generator, { interrupt: async () => setTimeout(() => release?.(), 50) });
      },
    }) as never);

    const controller = new AbortController();
    const first = driver.run({ prompt: "prompt", sessionId: "session_parked", cwd: "/tmp", signal: controller.signal, onObservations: recorder().onObservations });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("the human pressed stop"));
    // Claimed BEFORE the stopped turn has let go of the runtime.
    const second = run(driver, { sessionId: "session_parked", prompt: "carry on" });
    await expect(first).rejects.toThrow("the human pressed stop");
    await expect(second.result).resolves.toMatchObject({ text: "after stop" });
  });

  test("a config change recreates the process, resuming the conversation from the cursor", async () => {
    let queryCalls = 0;
    const resumes: unknown[] = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { resume?: string } }) {
        queryCalls += 1;
        resumes.push(options.resume);
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    await run(driver, { sessionId: "session_moving" }).result;
    await run(driver, { sessionId: "session_moving", cwd: "/tmp/elsewhere", providerSessionId: "prov-abc" }).result;
    expect(queryCalls).toBe(2);
    expect(resumes).toEqual([undefined, "prov-abc"]);
  });
});

describe("the session runtime", () => {
  test("a failed turn destroys the runtime; the next turn cold-starts instead of pumping a corpse", async () => {
    let queryCalls = 0;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        queryCalls += 1;
        for await (const message of prompt) {
          void message;
          if (queryCalls === 1) {
            yield { type: "result", subtype: "error_during_execution" };
            return;
          }
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    await expect(run(driver, { sessionId: "session_flaky" }).result).rejects.toThrow("error_during_execution");
    await run(driver, { sessionId: "session_flaky" }).result;
    expect(queryCalls).toBe(2);
  });

  test("a model change on a live runtime goes through setModel, not a new process", async () => {
    let queryCalls = 0;
    const modelsSet: unknown[] = [];
    const driver = createClaudeDriver(async () => ({
      query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        const generator = (async function* () {
          queryCalls += 1;
          for await (const message of prompt) {
            void message;
            yield { type: "result", subtype: "success" };
          }
        })();
        return Object.assign(generator, {
          setModel: async (model?: string) => {
            modelsSet.push(model);
          },
        });
      },
    }) as never);
    await run(driver, { sessionId: "session_switching", model: "opus[1m]" }).result;
    await run(driver, { sessionId: "session_switching", model: "sonnet[1m]" }).result;
    expect(queryCalls).toBe(1);
    expect(modelsSet).toEqual(["sonnet[1m]"]);
  });

  test("a WINDOW change cold-starts the process rather than trusting setModel with the suffix", async () => {
    let queryCalls = 0;
    const modelsSet: unknown[] = [];
    const baked: unknown[] = [];
    const driver = createClaudeDriver(async () => ({
      query({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { model?: string } }) {
        baked.push(options.model);
        const generator = (async function* () {
          queryCalls += 1;
          for await (const message of prompt) {
            void message;
            yield { type: "result", subtype: "success" };
          }
        })();
        return Object.assign(generator, { setModel: async (model?: string) => { modelsSet.push(model); } });
      },
    }) as never);
    await run(driver, { sessionId: "session_window", model: "opus" }).result;
    await run(driver, { sessionId: "session_window", model: "opus[1m]" }).result;
    expect(queryCalls).toBe(2);
    expect(modelsSet).toEqual([]);
    expect(baked).toEqual(["opus", "opus[1m]"]);
    // Same window, different family: the live knob is still the cheap path.
    await run(driver, { sessionId: "session_window", model: "sonnet[1m]" }).result;
    expect(queryCalls).toBe(2);
    expect(modelsSet).toEqual(["sonnet[1m]"]);
  });

  test("dispose closes every live runtime — the worker's stop is the session's end", async () => {
    let ended = false;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        try {
          for await (const message of prompt) {
            void message;
            yield { type: "result", subtype: "success" };
          }
        } finally {
          ended = true;
        }
      },
    }) as never);
    await run(driver, { sessionId: "session_disposable" }).result;
    expect(ended).toBe(false);
    driver.dispose?.();
    // Ending the feed lets the fake's for-await fall out; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ended).toBe(true);
  });
});

  test("a re-stamped MCP server record does not cold-start the process — only id and spec are identity", async () => {
    let queryCalls = 0;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        queryCalls += 1;
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    const serverAt = (at: number) => [
      { id: "mac", label: "Computer Use (Mac)", enabled: true, createdAt: at, updatedAt: at, spec: { transport: "stdio", command: "cua", args: ["mcp"] } },
    ];
    await run(driver, { sessionId: "session_stamped", mcpServers: serverAt(1) }).result;
    await run(driver, { sessionId: "session_stamped", mcpServers: serverAt(2) }).result;
    expect(queryCalls).toBe(1);
    // A change to the SPEC is real identity and still recreates.
    await run(driver, {
      sessionId: "session_stamped",
      mcpServers: [{ id: "mac", label: "Computer Use (Mac)", enabled: true, createdAt: 3, updatedAt: 3, spec: { transport: "stdio", command: "elsewhere", args: ["mcp"] } }],
    }).result;
    expect(queryCalls).toBe(2);
  });

  test("the idle pool never evicts a process that still owns background work", async () => {
    const ended: string[] = [];
    // Hoisted: `loadSdk` is invoked once per run, so a counter inside it would
    // reset and every query would think it was the first.
    let opened = 0;
    const driver = createClaudeDriver(async () => {
      return {
        async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
          const mine = (opened += 1);
          try {
            for await (const message of prompt) {
              void message;
              // The FIRST session launches a detached shell and leaves it
              // running; the rest are ordinary turns.
              if (mine === 1) {
                yield { type: "system", subtype: "task_started", task_id: "sdk_bg", tool_use_id: "use_bg", task_type: "bash", is_backgrounded: true, description: "tail -f build.log" };
              }
              yield { type: "result", subtype: "success" };
            }
          } finally {
            ended.push(`query_${mine}`);
          }
        },
      } as never;
    });
    for (const id of ["a", "b", "c", "d", "e"]) await run(driver, { sessionId: `session_pool_${id}` }).result;
    // The feed's generator only falls out once destroy ends it; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Five processes, one protected: the oldest EVICTABLE one goes instead.
    expect(ended).not.toContain("query_1");
    expect(ended).toEqual(["query_2"]);
  });

  const backgroundWorkDriver = (ended: string[], stopped: string[], unattendedBackgroundWorkMs: number) => {
    let opened = 0;
    return createClaudeDriver(
      async () => ({
        query({ prompt }: { prompt: AsyncIterable<unknown> }) {
          const mine = (opened += 1);
          const generator = (async function* () {
            try {
              for await (const message of prompt) {
                void message;
                // The FIRST session launches a detached shell and leaves it
                // running; the rest are ordinary turns.
                if (mine === 1) {
                  yield { type: "system", subtype: "task_started", task_id: "sdk_bg", tool_use_id: "use_bg", task_type: "bash", is_backgrounded: true, description: "bun test" };
                }
                yield { type: "result", subtype: "success" };
              }
            } finally {
              ended.push(`query_${mine}`);
            }
          })();
          return Object.assign(generator, { stopTask: async (taskId: string) => void stopped.push(taskId) });
        },
      }) as never,
      { unattendedBackgroundWorkMs },
    );
  };

  test("background work nobody has watched for the ceiling is stopped, and the process that held it ends", async () => {
    const ended: string[] = [];
    const stopped: string[] = [];
    // 30 ms stands in for thirty minutes: the ceiling is injected for exactly
    // the reason `providerSilenceMs` is — so a test never sleeps for a real one.
    const driver = backgroundWorkDriver(ended, stopped, 30);
    await run(driver, { sessionId: "session_unattended" }).result;

    // The shared wait (#760), not a copy: the sweep is on a timer, so what this
    // needs is a wall clock rather than a fixed sleep somebody guessed.
    await until("the unattended ceiling to stop the shell and end the process holding it", () => ended.includes("query_1"));
    // THE AFFORDANCE, WITH THE PROVIDER'S OWN HANDLE. Not a kill: the CLI was
    // asked to stop that task, which is what puts it on the session's row.
    expect(stopped).toEqual(["sdk_bg"]);
    // And the process that existed only to hold it is gone.
    expect(ended).toEqual(["query_1"]);
    driver.dispose?.();
  });

  test("and a session whose work is younger than the ceiling keeps it — the #201 fixtures, with a clock added", async () => {
    const ended: string[] = [];
    const stopped: string[] = [];
    const driver = backgroundWorkDriver(ended, stopped, 30_000);
    for (const id of ["a", "b", "c", "d", "e"]) await run(driver, { sessionId: `session_young_${id}` }).result;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Nothing was stopped, and the protected process is still the one the cap
    // spared — exactly the #201 answer.
    expect(stopped).toEqual([]);
    expect(ended).toEqual(["query_2"]);
    driver.dispose?.();
  });

  test("the cap is enforced on release, not only on adoption", async () => {
    const ended: string[] = [];
    let opened = 0;
    const driver = createClaudeDriver(async () => {
      return {
        async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
          const mine = (opened += 1);
          try {
            for await (const message of prompt) {
              void message;
              yield { type: "result", subtype: "success" };
            }
          } finally {
            ended.push(`query_${mine}`);
          }
        },
      } as never;
    });
    // Four sessions, none protected: the fourth's RELEASE is what takes the
    // pool to four evictable runtimes and must prune back to three.
    for (const id of ["a", "b", "c", "d"]) await run(driver, { sessionId: `session_cap_${id}` }).result;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ended).toEqual(["query_1"]);
  });

  test("an env patch reordered but unchanged reuses the process; a reordered server list does too", async () => {
    let queryCalls = 0;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        queryCalls += 1;
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    const server = (id: string) => ({ id, label: id, enabled: true, createdAt: 1, updatedAt: 1, spec: { transport: "stdio", command: id, args: ["mcp"] } });
    await run(driver, {
      sessionId: "session_ordered",
      env: { CLAUDE_CONFIG_DIR: "/tmp/cfg", ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
      mcpServers: [server("alpha"), server("beta")],
    }).result;
    await run(driver, {
      sessionId: "session_ordered",
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", CLAUDE_CONFIG_DIR: "/tmp/cfg" },
      mcpServers: [server("beta"), server("alpha")],
    }).result;
    expect(queryCalls).toBe(1);
  });

  test("deleting an inherited variable is its own identity, and the child really loses the key", async () => {
    let queryCalls = 0;
    const seen: Record<string, string | undefined>[] = [];
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { env?: Record<string, string | undefined> } }) {
        queryCalls += 1;
        seen.push(options.env ?? {});
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    process.env.TELAR_TEST_AMBIENT_CREDENTIAL = "ambient-secret";
    try {
      await run(driver, { sessionId: "session_deleting", env: { CLAUDE_CONFIG_DIR: "/tmp/cfg" } }).result;
      await run(driver, { sessionId: "session_deleting", env: { CLAUDE_CONFIG_DIR: "/tmp/cfg", TELAR_TEST_AMBIENT_CREDENTIAL: undefined } }).result;
      // Two different instructions, therefore two processes.
      expect(queryCalls).toBe(2);
      expect(seen[0]?.TELAR_TEST_AMBIENT_CREDENTIAL).toBe("ambient-secret");
      // GONE, not present-and-undefined: nothing downstream has to guess.
      expect(Object.hasOwn(seen[1]!, "TELAR_TEST_AMBIENT_CREDENTIAL")).toBeFalse();
      // The rest of the worker's environment still reaches the child.
      expect(seen[1]?.CLAUDE_CONFIG_DIR).toBe("/tmp/cfg");
    } finally {
      delete process.env.TELAR_TEST_AMBIENT_CREDENTIAL;
    }
  });

  test("the runtime debug line names the changed field and prints no secret", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }) as never);
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    process.env.TELAR_CLAUDE_RUNTIME_DEBUG = "1";
    try {
      await run(driver, { sessionId: "session_debug", env: { ANTHROPIC_API_KEY: "sk-secret-one" } }).result;
      await run(driver, {
        sessionId: "session_debug",
        env: { ANTHROPIC_API_KEY: "sk-secret-two" },
        browserSocket: { url: "http://127.0.0.1:1/mcp", token: "browser-bearer-token" },
      }).result;
    } finally {
      console.error = realError;
      delete process.env.TELAR_CLAUDE_RUNTIME_DEBUG;
    }
    const logged = lines.join("\n");
    expect(logged).not.toContain("sk-secret-one");
    expect(logged).not.toContain("sk-secret-two");
    expect(logged).not.toContain("browser-bearer-token");
    // It still answers the question it exists for: which field broke reuse.
    const reuse = lines.filter((line) => line.startsWith("[claude-runtime]"));
    expect(reuse.at(-1)).toContain("reuse=false");
    expect(reuse.at(-1)).toContain("changed=browser,env");
  });

  test("the gated timing line carries whitelisted scalars and nothing else", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query() {
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 255_715,
          duration_api_ms: 254_010,
          ttft_ms: 8_973,
          num_turns: 4,
          stop_reason: "end_turn",
          result: "the model's whole answer, which must not be logged",
          usage: { input_tokens: 32, output_tokens: 6 },
        };
      },
    }));
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    process.env.TELAR_CLAUDE_RUNTIME_DEBUG = "1";
    try {
      await run(driver, { sessionId: "session_timed" }).result;
    } finally {
      console.error = realError;
      delete process.env.TELAR_CLAUDE_RUNTIME_DEBUG;
    }
    const timing = lines.find((line) => line.startsWith("[claude-timing]"));
    expect(timing).toBeDefined();
    expect(JSON.parse(timing!.slice(timing!.indexOf("{")))).toEqual({
      durationMs: 255_715,
      apiMs: 254_010,
      ttftMs: 8_973,
      turns: 4,
      stopReason: "end_turn",
      subtype: "success",
    });
    expect(timing).not.toContain("must not be logged");
  });

  test("the diagnostics are OFF unless asked for", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query() {
        yield { type: "result", subtype: "success", duration_ms: 12 };
      },
    }));
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await run(driver, { sessionId: "session_quiet" }).result;
    } finally {
      console.error = realError;
    }
    expect(lines).toEqual([]);
  });

  test("stopTask reaches into the session's live runtime and stops one background task by provider id", async () => {
    const stopped: string[] = [];
    const driver = createClaudeDriver(async () => ({
      query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        const generator = (async function* () {
          for await (const message of prompt) {
            void message;
            yield { type: "result", subtype: "success" };
          }
        })();
        return Object.assign(generator, {
          stopTask: async (taskId: string) => {
            stopped.push(taskId);
          },
        });
      },
    }) as never);
    // A turn creates the live runtime; then the task is stopped between turns.
    await run(driver, { sessionId: "session_kill" }).result;
    const took = await driver.stopTask?.("session_kill", "bqo5yo8lm");
    expect(took).toBe(true);
    expect(stopped).toEqual(["bqo5yo8lm"]);
    // A session with no live runtime is an honest false, not a throw.
    expect(await driver.stopTask?.("session_unknown", "whatever")).toBe(false);
  });
