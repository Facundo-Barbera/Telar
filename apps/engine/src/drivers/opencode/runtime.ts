import { OPENCODE_VERSION, openCodeVersionVerdict } from "./version";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { autoCompactLimitFor, type AutoCompact } from "@telar/engine-client";
import { BROWSER_BRIEFING } from "../../domains/browser";
import { RUN_BRIEFING } from "../../run/briefing";
import { pluginBriefings } from "../../plugins/bundled";
import { writeOrientationInstructions } from "../../orientation";
import type { DriverRun } from "../../provider-contract";

export type OpenCodeRuntime = { client: OpencodeClient; closed: boolean; close(): void };

export function openCodeBriefings(input: DriverRun): string[] {
  return [
    ...(input.orientation ? [input.orientation] : []),
    ...(input.mainBriefing ? [input.mainBriefing] : []),
    ...(input.browserSocket ? [BROWSER_BRIEFING] : []),
    ...(input.run ? [RUN_BRIEFING] : []),
    ...pluginBriefings(Object.keys(input.plugins ?? {})),
  ];
}

export function openCodeConfigContent(input: DriverRun, instructionsFile?: string, limits?: OpenCodeModelLimits): string {
  const inherited = JSON.parse(input.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    instructions?: unknown;
    compaction?: { reserved?: unknown };
  };
  const existing = Array.isArray(inherited.instructions) ? (inherited.instructions as string[]) : [];
  const instructions = instructionsFile ? [...existing, instructionsFile] : existing;
  const model = splitOpenCodeModel(input.model);
  const reserved = inherited.compaction?.reserved;
  const compaction = model && openCodeCompactionConfig(input.autoCompact, model.providerID, model.modelID, limits,
    typeof reserved === "number" ? reserved : undefined, openCodeOutputTokenMax({ ...process.env, ...input.env }));
  return JSON.stringify({
    ...(compaction ? mergeConfig(inherited, compaction) as object : inherited),
    ...(instructions.length ? { instructions } : {}),
    permission: "ask",
    share: "disabled",
  });
}

const OPENCODE_DISABLE_AUTOCOMPACT_ENV = "OPENCODE_DISABLE_AUTOCOMPACT";
const OPENCODE_OUTPUT_TOKEN_MAX_ENV = "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX";
const OPENCODE_OUTPUT_TOKEN_MAX = 32_000;
const OPENCODE_RESERVE = 20_000;

export type OpenCodeModelLimits = { context: number; output: number; input?: number };

export function openCodeCompactionEnv(autoCompact: AutoCompact | undefined): Record<string, string | undefined> {
  if (!autoCompact) return {};
  return { [OPENCODE_DISABLE_AUTOCOMPACT_ENV]: autoCompact.mode === "never" ? "1" : undefined };
}

function splitOpenCodeModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const slash = model?.indexOf("/") ?? -1;
  return model && slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined;
}

function openCodeOutputTokenMax(env: Record<string, string | undefined>): number {
  const value = Number.parseInt(env[OPENCODE_OUTPUT_TOKEN_MAX_ENV] ?? "", 10);
  return value > 0 ? value : OPENCODE_OUTPUT_TOKEN_MAX;
}

export function openCodeCompactionThreshold(limits: OpenCodeModelLimits, reserved?: number, outputTokenMax = OPENCODE_OUTPUT_TOKEN_MAX): number {
  if (limits.context === 0) return 0;
  const maxOutput = Math.min(limits.output, outputTokenMax) || outputTokenMax;
  const reserve = reserved ?? Math.min(OPENCODE_RESERVE, maxOutput);
  return limits.input ? Math.max(0, limits.input - reserve) : Math.max(0, limits.context - maxOutput);
}

export function openCodeCompactionConfig(
  autoCompact: AutoCompact | undefined,
  providerID: string,
  modelID: string,
  limits: OpenCodeModelLimits | undefined,
  reserved?: number,
  outputTokenMax = OPENCODE_OUTPUT_TOKEN_MAX,
): { provider: Record<string, { models: Record<string, { limit: Required<OpenCodeModelLimits> }> }> } | undefined {
  if (autoCompact?.mode !== "limits" || !limits || limits.context <= 0) return undefined;
  const tokens = autoCompactLimitFor(autoCompact, limits.context);
  if (tokens >= openCodeCompactionThreshold(limits, reserved, outputTokenMax)) return undefined;
  const maxOutput = Math.min(limits.output, outputTokenMax) || outputTokenMax;
  const input = tokens + (reserved ?? Math.min(OPENCODE_RESERVE, maxOutput));
  return { provider: { [providerID]: { models: { [modelID]: { limit: { context: limits.context, output: limits.output, input } } } } } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function mergeConfig(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) merged[key] = mergeConfig(base[key], value);
  return merged;
}

export function parseOpenCodeModelLimits(stdout: string): Map<string, OpenCodeModelLimits> {
  const models = new Map<string, OpenCodeModelLimits>();
  for (const [, id, json] of stdout.matchAll(/^(\S+\/\S+)\r?\n(\{[\s\S]*?\r?\n\})\s*$/gm)) {
    try {
      const limit = (JSON.parse(json!) as { limit?: Record<string, unknown> }).limit;
      if (!limit || typeof limit.context !== "number" || typeof limit.output !== "number") continue;
      models.set(id!, { context: limit.context, output: limit.output, ...(typeof limit.input === "number" ? { input: limit.input } : {}) });
    } catch { /* one unreadable model costs only itself */ }
  }
  return models;
}

const modelLimitsCache = new Map<string, Promise<Map<string, OpenCodeModelLimits>>>();

export async function openCodeModelLimits(
  binary: string, model: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<OpenCodeModelLimits | undefined> {
  const split = splitOpenCodeModel(model);
  if (!split) return undefined;
  const key = JSON.stringify([binary, split.providerID]);
  let pending = modelLimitsCache.get(key);
  if (!pending) {
    pending = promisify(execFile)(binary, ["models", split.providerID, "--verbose"],
      { cwd: options.cwd, env: options.env, timeout: 10_000, maxBuffer: 32_000_000 })
      .then(({ stdout }) => parseOpenCodeModelLimits(stdout));
    modelLimitsCache.set(key, pending);
    pending.catch(() => modelLimitsCache.delete(key));
  }
  return pending.then((models) => models.get(model), () => undefined);
}

export async function startOpenCodeRuntime(input: DriverRun): Promise<OpenCodeRuntime> {
  const password = crypto.randomBytes(32).toString("base64url");
  const briefings = openCodeBriefings(input);
  const instructionsFile = briefings.length
    ? await writeOrientationInstructions(briefings.join("\n\n")).catch(() => undefined)
    : undefined;
  const binary = input.binaryPath ?? "opencode";
  const inheritedEnv = { ...process.env, ...input.env };
  const limits = input.autoCompact?.mode === "limits" && input.model
    ? await openCodeModelLimits(binary, input.model, { cwd: input.cwd, env: inheritedEnv })
    : undefined;
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: openCodeConfigContent(input, instructionsFile, limits) };
  Object.assign(env, openCodeCompactionEnv(input.autoCompact));
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const child = spawn(binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: input.cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  let terminated = false;
  const close = () => {
    if (terminated) return;
    terminated = true;
    closed = true;
    if (child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      const kill = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 1_000);
      kill.unref();
    } else child.kill();
  };
  child.once("exit", () => { closed = true; });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("OpenCode server startup timed out")), 15_000);
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer); input.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(url!);
      };
      const abort = () => finish(new Error("OpenCode startup cancelled"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) return abort();
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`OpenCode server exited (${code})`)));
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-16_384);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) finish(undefined, match[1]);
      });
      child.stderr.on("data", () => {});
    });
    const client = createOpencodeClient({ baseUrl: url, directory: input.cwd, throwOnError: true,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    const health = await client.global.health({ throwOnError: true, signal: AbortSignal.timeout(10_000) });
    if (openCodeVersionVerdict(health.data?.version) === "incompatible") {
      throw new Error(`OpenCode ${health.data?.version ?? "unknown"} is not supported by this adapter; install opencode-ai@${OPENCODE_VERSION} or set this provider's binary path to that version.`);
    }
    return { client, get closed() { return closed; }, close };
  } catch (error) { close(); throw error; }
}
