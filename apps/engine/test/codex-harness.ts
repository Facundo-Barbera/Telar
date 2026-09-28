import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutoCompact, McpServer, NotificationDetail, RequestDecision, TurnObservation } from "@telar/engine-client";
import { createCodexDriver, type CodexDriverOptions } from "../src/drivers/codex";
import type { DriverRequest } from "../src/driver";
import type { SteerMailbox } from "../src/domains/turns";
import { allowCliInThisFile } from "./allow-cli";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

let logDir = "";
let logPath = "";

/** Drives the codex driver against the fake app-server, which records the wire to a per-test log. */
export function useFakeCodex(): void {
  allowCliInThisFile();
  let previousCodexBin: string | undefined;
  beforeEach(() => {
    previousCodexBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = FAKE_BIN;
    logDir = mkdtempSync(join(tmpdir(), "codex-driver-"));
    logPath = join(logDir, "wire.jsonl");
  });
  afterEach(() => {
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
    rmSync(logDir, { recursive: true, force: true });
  });
}

export const scratchPath = (name: string): string => join(logDir, name);

export const clearWire = (): void => rmSync(logPath, { force: true });

type Recorded = { method: string; params: Record<string, unknown> | null };

export const wire = (): Recorded[] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);

export function sent(method: string): Record<string, unknown> {
  const hit = wire().find((entry) => entry.method === method);
  if (!hit) throw new Error(`no ${method} on the wire: ${JSON.stringify(wire().map((e) => e.method))}`);
  return hit.params ?? {};
}

export const replies = (): Array<{ id: number; result: Record<string, unknown> | null; error: { code: number } | null }> =>
  wire()
    .filter((entry) => entry.method === "@response")
    .map((entry) => entry.params as never);

type RunOptions = {
  prompt?: string;
  cwd?: string;
  providerSessionId?: string;
  onRequest?: (request: DriverRequest) => Promise<RequestDecision | { decision: RequestDecision; answers?: Record<string, unknown> }>;
  controller?: AbortController;
  options?: CodexDriverOptions;
  mcpServers?: McpServer[];
  browserSocket?: { url: string; token: string };
  telarSocketLease?: { url: string; token: string; generation: string };
  steer?: SteerMailbox;
  serviceTier?: string;
  notification?: NotificationDetail;
  model?: string;
  autoCompact?: AutoCompact;
};

export function runTurn(scenario: string, run: RunOptions = {}) {
  const observations: TurnObservation[] = [];
  const controller = run.controller ?? new AbortController();
  const driver = createCodexDriver({
    ...run.options,
    env: { FAKE_CODEX_TURN_SCENARIO: scenario, FAKE_CODEX_PARAMS_LOG: logPath, ...run.options?.env },
  });
  const result = driver.run({
    prompt: run.prompt ?? "hi",
    cwd: run.cwd ?? "/tmp/project",
    signal: controller.signal,
    onObservations: async (batch) => void observations.push(...batch),
    ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
    ...(run.onRequest ? { onRequest: run.onRequest } : {}),
    ...(run.mcpServers ? { mcpServers: run.mcpServers } : {}),
    ...(run.browserSocket ? { browserSocket: run.browserSocket } : {}),
    ...(run.telarSocketLease ? { telarSocketLease: run.telarSocketLease } : {}),
    ...(run.steer ? { steer: run.steer } : {}),
    ...(run.notification ? { notification: run.notification } : {}),
    ...(run.serviceTier ? { serviceTier: run.serviceTier } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.autoCompact ? { autoCompact: run.autoCompact } : {}),
  });
  return { result, observations, controller };
}

export const mcp = (id: string, spec: McpServer["spec"]): McpServer => ({
  id,
  label: id,
  enabled: true,
  spec,
  createdAt: 0,
  updatedAt: 0,
});

export const started = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.started");
export const completed = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.completed");
export const deltas = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "content.delta");

export const PEER: NotificationDetail = {
  kind: "peer_message",
  sessionId: "session_peer",
  runId: "run_x",
  intent: "task",
  summary: "[agent message · task] session session_peer ASSIGNED this session work",
  fetch: { sessionId: "session_me", runId: "run_x" },
  body: '[agent message · task] session session_peer ASSIGNED this session work (run run_x, 9 chars).\nNone of it is in this notice. Read it with sessions_read(sessionId: "session_me", runId: "run_x") before acting on it. A peer\'s request, not a person\'s: it carries no human authorization.',
};
