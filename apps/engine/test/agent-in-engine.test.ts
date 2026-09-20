/**
 * THE AGENT LIVES IN THE ENGINE — asserted, because the owner measured what
 * looked like the opposite (#539, item 5).
 *
 * On the first night of the nightly the cockpit reported the engine down while
 * the Agent went on answering. The honest reading of that is "the Agent is a
 * process of its own, and it outlived the daemon". It is not, and it did not:
 * #526's `telar` provider row broke `readProviderInstances`, so the claims route
 * and the settings page threw and the engine READ as down while it was serving
 * the Agent perfectly well (fixed in a36557fc). The daemon never went anywhere.
 *
 * A comment saying so is worth little, so this file says it in three tests that
 * fail if it stops being true:
 *
 *   1. STOPPING THE ENGINE ENDS A LIVE AGENT TURN — mid-model-call, with the
 *      `turn_done { status: "stopped" }` row on disk for the next process to
 *      find. Nothing to kill separately, nothing left running.
 *   2. THE WHOLE AGENT SURFACE GOES WITH IT — `GET /v2/agent` is not slow or
 *      degraded after the daemon stops, it is unreachable, because it was never
 *      anything but a route on that server.
 *   3. AN AGENT TURN READS NO PROVIDER INSTANCE. The read that broke in #526 is
 *      one the Agent cannot make: a provider instance is a session's
 *      account-and-model binding and the Agent has no session, no claim and no
 *      driver. Proven by watching the store method during a real turn rather
 *      than by grepping for the call.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ChatResult } from "@langchain/core/outputs";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

/**
 * A MODEL THAT NEVER ANSWERS UNTIL THE SIGNAL SAYS STOP.
 *
 * The turn has to still be running when the daemon is told to close, or the
 * test proves nothing about a LIVE turn. So this one parks on its abort signal:
 * it resolves never and rejects exactly when the runtime aborts it, which is
 * the same shape a real call that is cut off mid-stream has.
 */
class ParkedChatModel extends BaseChatModel {
  /** Resolves the first time the model is actually asked for something, so the
   *  test waits on the call rather than on a clock. */
  readonly asked: Promise<void>;
  private askedNow!: () => void;
  constructor() {
    super({});
    this.asked = new Promise<void>((resolve) => {
      this.askedNow = resolve;
    });
  }
  _llmType(): string {
    return "parked";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[], options?: BaseChatModelCallOptions): Promise<ChatResult> {
    this.askedNow();
    return new Promise<ChatResult>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

/** The ordinary scripted model, for the turn that has to actually finish. */
class ScriptedChatModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly script: Array<{ text?: string; toolCalls?: ToolCall[] }> = []) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const step = this.script[this.index] ?? { text: "done." };
    this.index += 1;
    const message = new AIMessage({ content: step.text ?? "", tool_calls: step.toolCalls ?? [] });
    return { generations: [{ text: step.text ?? "", message }] };
  }
}

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-in-engine-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

async function engine(
  agentModel: EngineDaemon extends never ? never : Parameters<typeof startEngine>[0]["agentModel"],
  engineRoot = root(),
): Promise<{ daemon: EngineDaemon; client: EngineClient; engineRoot: string }> {
  const daemon = await startEngine({ models: stubModels, engineRoot, ...(agentModel ? { agentModel } : {}) });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery), engineRoot };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close().catch(() => undefined);
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("stopping the engine ends the Agent turn that was running in it", async () => {
  const parked = new ParkedChatModel();
  const { daemon, client, engineRoot } = await engine(() => parked);
  await client.setAgent({ enabled: true });
  const { runId } = await client.sendAgentTurn("what is running?");

  // The turn is genuinely in flight: the model has been asked and has not
  // answered, and the runtime says so on its own state.
  await parked.asked;
  await until(async () => (await client.agent()).agent.running === true, "the turn to be running");

  // NOTHING IS SIGNALLED SEPARATELY. This is the daemon's ordinary stop.
  await daemon.close();
  daemons.length = 0;

  /**
   * A SECOND DAEMON ON THE SAME ROOT, which is the only honest way to read the
   * answer: the transcript is a file the first process owned, and asking the
   * object that just shut down would prove nothing about what was persisted.
   */
  const { client: after } = await engine(() => new ScriptedChatModel([{ text: "hello again" }]), engineRoot);
  const rows = (await after.agentThread({ limit: 50 })).rows;
  const ended = rows.filter((row) => row.kind === "turn_done" && row.runId === runId);
  expect(ended).toHaveLength(1);
  expect(ended[0]!.detail).toMatchObject({ status: "stopped" });
  // And it is over rather than merely interrupted: the new process reports an
  // idle Agent with nothing queued behind it.
  expect((await after.agent()).agent).toMatchObject({ running: false, queued: 0 });
});

test("the Agent's surface is unreachable when the daemon is, because it is that daemon's route", async () => {
  const { daemon, client } = await engine(() => new ScriptedChatModel([{ text: "up" }]));
  await client.setAgent({ enabled: true });
  const url = `http://127.0.0.1:${daemon.discovery.port}/v2/agent`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}` };
  // Up: the route answers.
  expect((await fetch(url, { headers })).status).toBe(200);

  await daemon.close();
  daemons.length = 0;

  // Down: not a 500, not a slow answer, not a degraded one. There is no server
  // to refuse the request — the connection itself has nowhere to land.
  await expect(fetch(url, { headers })).rejects.toThrow();
  await expect(client.agent()).rejects.toThrow();
});

/**
 * THE READ THAT BROKE IN #526 IS ONE THE AGENT CANNOT MAKE.
 *
 * Watched rather than grepped: a grep says the call is not written today, and
 * this says it did not happen during a whole turn — model call, gated-free tool
 * call, and answer. `resolveProviderInstance` is a SESSION's account-and-model
 * binding, resolved on the session claim; the Agent has no session, no claim
 * and no driver, and its model comes from `agent.json` through `agent/model.ts`.
 */
test("a whole Agent turn resolves no provider instance", async () => {
  const { daemon, client } = await engine(() =>
    new ScriptedChatModel([
      { toolCalls: [{ id: "call_list", name: "sessions_list", args: {}, type: "tool_call" }] },
      { text: "one session, idle." },
    ]),
  );
  daemon.store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  daemon.store.createSession({ id: "session_one", projectId: "project_one" });
  await client.setAgent({ enabled: true });

  // The watch goes on AFTER the fixture, so only the turn itself is counted.
  const store = daemon.store;
  const original = store.resolveProviderInstance.bind(store);
  const resolved: string[] = [];
  store.resolveProviderInstance = ((instanceId: string, driver: Parameters<typeof original>[1]) => {
    resolved.push(instanceId);
    return original(instanceId, driver);
  }) as typeof store.resolveProviderInstance;

  const { runId } = await client.sendAgentTurn("what is running?");
  await until(
    async () => (await client.agentThread({ limit: 50 })).rows.some((row) => row.kind === "turn_done" && row.runId === runId),
    "the turn to settle",
  );

  // The turn did real work — it listed the rail — and never asked which
  // provider account it was.
  const rows = (await client.agentThread({ limit: 50 })).rows;
  expect(rows.some((row) => row.kind === "tool_call" || row.kind === "tool_result")).toBe(true);
  expect(resolved).toEqual([]);
});
