import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultInstanceIdForDriver, workspacePath, type SessionWorkspace, type TextGenPolicy } from "@telar/engine-client";
import { requireCli } from "./cli";

type TextGenEffort = "low" | "medium" | "high";

type TextGenDriverInput = {
  driver: "claude" | "codex";
  binaryPath?: string;
  env?: Record<string, string>;
  cwd: string;
  model?: string;
  effort?: TextGenEffort;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

export function textGenDisabledByEnv(): boolean {
  return (process.env.TELAR_TEXTGEN ?? "").trim().toLowerCase() === "off";
}

function effectiveTextGenPolicy(policy: TextGenPolicy): TextGenPolicy {
  return textGenDisabledByEnv() ? { ...policy, titles: false, renameBranches: false } : policy;
}

function oneStringSchema(key: string): object {
  return {
    type: "object",
    properties: { [key]: { type: "string" } },
    required: [key],
    additionalProperties: false,
  };
}

const TITLE_PROMPT = `Generate a title that will help the user recognize this coding session weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid quotes, labels, filler, and trailing punctuation.`;

const MAX_PROMPT_MESSAGE_CHARS = 8_000;

export function buildTitlePrompt(message: string): string {
  return `${TITLE_PROMPT}\n\nUser message:\n${message.slice(0, MAX_PROMPT_MESSAGE_CHARS)}`;
}

export function sanitizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!line) return undefined;
  return line.slice(0, 80);
}

export function titleIsSeed(title: string, firstMessage: string): boolean {
  const current = title.trim();
  if (current === "New session") return true;
  const seed = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return seed.length > 0 && current === seed;
}

async function runStructured(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  try {
    return input.driver === "claude" ? await runClaude(input, prompt, schema) : await runCodex(input, prompt, schema);
  } catch {
    return undefined;
  }
}

async function runClaude(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  const executable = requireCli("claude", input.binaryPath ? { binaryPath: input.binaryPath } : {});
  const args = [
    "-p",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--max-turns",
    "1",
    "--system-prompt",
    "Answer with the requested JSON only.",
    ...(input.model ? ["--model", input.model] : []),
  ];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-textgen-"));
  try {
    const stdout = await runToCompletion(executable, args, { ...input, cwd: scratch }, prompt);
    if (stdout === undefined) return undefined;
    const envelope = parseJson(stdout);
    const structured = envelope?.["structured_output"];
    return typeof structured === "object" && structured !== null ? (structured as Record<string, unknown>) : undefined;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function runCodex(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  const executable = requireCli("codex", input.binaryPath ? { binaryPath: input.binaryPath } : {});
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-textgen-"));
  const schemaPath = path.join(scratch, "schema.json");
  const outputPath = path.join(scratch, "answer.json");
  try {
    fs.writeFileSync(schemaPath, JSON.stringify(schema));
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      ...(input.model ? ["--model", input.model] : []),
      "--config",
      `model_reasoning_effort="${input.effort ?? "low"}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ];
    const stdout = await runToCompletion(executable, args, input, prompt);
    if (stdout === undefined) return undefined;
    const answer = parseJson(fs.readFileSync(outputPath, "utf8"));
    return answer ?? undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runToCompletion(executable: string, args: string[], input: TextGenDriverInput, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve(undefined);
      return;
    }
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    let out = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(undefined);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(undefined));
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code) => finish(code === 0 ? out : undefined));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function generateSessionTitle(input: TextGenDriverInput & { message: string }): Promise<string | undefined> {
  const result = await runStructured(input, buildTitlePrompt(input.message), oneStringSchema("title"));
  return sanitizeTitle(result?.["title"]);
}

type TextGenInstance = { enabled: boolean; binaryPath?: string; env: { name: string; value: string }[] };

type TextGenStore = {
  settings: { textGen(): TextGenPolicy };
  providers: { resolve(instanceId: string, driver: "claude" | "codex"): TextGenInstance };
};

type StructuredPolicyStore = TextGenStore & { paths?: { root?: string } };

function instanceInput(instance: TextGenInstance): Pick<TextGenDriverInput, "binaryPath" | "env"> {
  const env: Record<string, string> = {};
  for (const variable of instance.env) if (variable.value) env[variable.name] = variable.value;
  return { ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}), env };
}

export async function runStructuredForPolicy(
  store: StructuredPolicyStore,
  input: { prompt: string; schema: object; model?: string; effort?: TextGenEffort; signal?: AbortSignal },
): Promise<Record<string, unknown> | undefined> {
  if (textGenDisabledByEnv()) return undefined;
  let policy: TextGenPolicy;
  let instance: TextGenInstance;
  try {
    policy = store.settings.textGen();
    if (policy.driver === "opencode") return undefined;
    instance = store.providers.resolve(defaultInstanceIdForDriver(policy.driver), policy.driver);
  } catch {
    return undefined;
  }
  if (!instance.enabled) return undefined;
  const model = input.model ?? policy.model;
  return runStructured(
    {
      driver: policy.driver,
      ...instanceInput(instance),
      cwd: store.paths?.root ?? os.tmpdir(),
      ...(model ? { model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    input.prompt,
    input.schema,
  );
}

export type RetitleStore = TextGenStore & {
  records: { get(sessionId: string): { title: string; state: string; workspace: SessionWorkspace } };
  lifecycle: {
    updateSession(sessionId: string, patch: { title: string }): unknown;
    refreshWorktreeBranchFromTitle(sessionId: string): string | undefined | Promise<string | undefined>;
  };
};

export async function maybeRetitleSession(
  store: RetitleStore,
  sessionId: string,
  firstMessage: string,
  generate: typeof generateSessionTitle = generateSessionTitle,
): Promise<void> {
  const policy = effectiveTextGenPolicy(store.settings.textGen());
  if (!policy.titles || policy.driver === "opencode") return;
  if (!firstMessage.trim()) return;
  let session: ReturnType<RetitleStore["records"]["get"]>;
  try {
    session = store.records.get(sessionId);
  } catch {
    return;
  }
  if (session.state !== "active" || !titleIsSeed(session.title, firstMessage)) return;
  const cwd = workspacePath(session.workspace);
  if (cwd === undefined) return;
  const instance = store.providers.resolve(defaultInstanceIdForDriver(policy.driver), policy.driver);
  if (!instance.enabled) return;
  const title = await generate({
    driver: policy.driver,
    ...instanceInput(instance),
    cwd,
    ...(policy.model ? { model: policy.model } : {}),
    message: firstMessage,
  });
  if (title === undefined) return;
  try {
    const current = store.records.get(sessionId);
    if (current.state !== "active" || !titleIsSeed(current.title, firstMessage) || current.title === title) return;
    store.lifecycle.updateSession(sessionId, { title });
  } catch {
    return;
  }
  if (policy.renameBranches) {
    try {
      await store.lifecycle.refreshWorktreeBranchFromTitle(sessionId);
    } catch {
      // The new title stands even when the branch rename fails.
    }
  }
}
