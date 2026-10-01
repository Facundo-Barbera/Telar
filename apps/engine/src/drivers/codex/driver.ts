import type { TurnObservation } from "@telar/engine-client";
import { requireCwd, type DriverResult, type DriverRun, type TurnDriver } from "../contract";
import { CodexAppServer, resolveCodexBinary } from "./app-server";
import { str } from "./items";
import { answerCodexRequests } from "./requests";
import { pumpCodexSteers } from "./steer";
import { codexSandboxPolicy, codexThreadParams, codexTurnInput, defaultThreadConfig, type CodexThreadConfig } from "./thread";
import { CodexTurn } from "./turn";
import { codexWindowConfig, readCodexWindows, type CodexWindow } from "./windows";
import { agentEnv } from "../../platform/process/agent-env";

export type CodexDriverOptions = {
  model?: string;
  effort?: string;
  serviceTier?: string;
  env?: Record<string, string | undefined>;
  resolveBin?: (binaryPath?: string) => string;
  threadConfig?: CodexThreadConfig;
  readWindows?: (bin: string) => Promise<ReadonlyMap<string, CodexWindow>>;
};

const DEFAULT_CODEX_MODEL = "gpt-5.5";
const CODEX_INITIALIZE_TIMEOUT_MS = 30_000;

// A method name no app-server message can collide with; carries a cancel out of the readline callback.
const CANCEL_SENTINEL = "@telar/cancelled";

class CodexTurnCancelled extends Error {
  constructor() {
    super("The human cancelled this turn.");
    this.name = "CodexTurnCancelled";
  }
}

/** Runs each turn in its own `codex app-server`, reaped when the turn ends. */
export function createCodexDriver(options: CodexDriverOptions = {}): TurnDriver {
  return { run: (run) => runCodexTurn(options, run) };
}

async function runCodexTurn(options: CodexDriverOptions, run: DriverRun): Promise<DriverResult> {
  const { signal, onRequest } = run;
  const cwd = requireCwd(run.cwd, "Codex");
  const requestedModel = run.model ?? options.model ?? DEFAULT_CODEX_MODEL;
  const bin = (options.resolveBin ?? resolveCodexBinary)(run.binaryPath);
  const windows =
    /\[1m\]$/i.test(requestedModel) || run.autoCompact?.mode === "limits"
      ? await (options.readWindows ?? readCodexWindows)(bin)
      : new Map<string, CodexWindow>();
  const { model, config: windowConfig } = codexWindowConfig(requestedModel, windows, run.autoCompact);
  const threadConfig = options.threadConfig ?? defaultThreadConfig(Boolean(onRequest));
  // The turn's login env wins over the worker's; a variable patched to undefined is removed.
  const client = new CodexAppServer(bin, { ...agentEnv(), ...options.env, ...run.env });

  let cancelled = false;
  const pending: TurnObservation[] = [];
  const emit = (observation: TurnObservation): void => void pending.push(observation);
  const flush = async (): Promise<void> => {
    if (pending.length > 0) await run.onObservations(pending.splice(0, pending.length));
  };
  const turn = new CodexTurn(emit);

  const abort = () => client.kill();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  answerCodexRequests(client, onRequest, () => {
    cancelled = true;
    client.notifications.push({ method: CANCEL_SENTINEL, params: {} });
  });

  try {
    await client.request("initialize", {
      clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, CODEX_INITIALIZE_TIMEOUT_MS);
    client.notify("initialized");

    const thread = codexThreadParams(run, { cwd, model, config: threadConfig, windowConfig, serviceTier: options.serviceTier });
    const started = run.providerSessionId
      ? await client.request<{ thread?: { id?: string } }>("thread/resume", { threadId: run.providerSessionId, ...thread.params })
      : await client.request<{ thread?: { id?: string } }>("thread/start", thread.params);
    turn.threadId = str(started.thread?.id) ?? run.providerSessionId ?? "";
    if (!turn.threadId) throw new Error("codex app-server started no thread");
    // Reported at once: a stopped turn never completes, and the session would lose its resume cursor.
    emit({ kind: "provider.session", providerSessionId: turn.threadId });

    // A resumed thread may point at a new socket URL. Non-fatal: a stale catalogue costs tools, not the turn.
    if (thread.hasMcpServers) {
      try {
        await client.request("config/mcpServer/reload", {});
      } catch (error) {
        console.warn("codex MCP catalogue refresh failed before turn", error instanceof Error ? error.message : error);
      }
    }

    const effort = run.effort ?? options.effort;
    const startedTurn = await client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: turn.threadId,
      input: codexTurnInput(run.notification ? run.notification.summary : run.prompt, run.attachments ?? []),
      ...(effort ? { effort } : {}),
      model,
      approvalPolicy: threadConfig.approvalPolicy,
      approvalsReviewer: threadConfig.approvalsReviewer,
      sandboxPolicy: codexSandboxPolicy(threadConfig.sandbox, cwd),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(run.serviceTier ? { serviceTierForTurn: run.serviceTier } : {}),
    });
    turn.turnId = str(startedTurn.turn?.id) ?? "";

    if (run.steer) void pumpCodexSteers(run.steer, client, turn, emit);

    for (;;) {
      const { value: notification, done } = await client.notifications.next();
      if (done) throw new Error("codex app-server closed the connection mid-turn");
      if (notification.method === CANCEL_SENTINEL) throw new CodexTurnCancelled();
      const finished = turn.handle(notification.method, notification.params);
      await flush();
      if (!finished) continue;
      if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
      return { text: turn.text, providerSessionId: turn.threadId, ...(turn.usage ? { usage: turn.usage } : {}) };
    }
  } catch (error) {
    // A killed subprocess surfaces as an exit code; report what actually happened.
    if (cancelled) throw new CodexTurnCancelled();
    if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    client.kill();
  }
}
