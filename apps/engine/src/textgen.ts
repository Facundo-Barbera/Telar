/**
 * Generated text, out of band — t3 code's TextGeneration design on Telar's
 * engine (recovered from its bundle: one-shot CLI subprocess, prompt on stdin,
 * a JSON schema the harness must satisfy, and the session's live provider
 * process never involved).
 *
 * WHY A SUBPROCESS AND NOT THE RUNNING SESSION: the session's turn is a
 * conversation somebody is watching, and a title request injected into it
 * would appear in the transcript, spend the turn's context, and arrive only
 * when the turn does. A `claude -p` / `codex exec` child costs one small model
 * call, cannot touch the transcript, and dies with its timeout.
 *
 * EVERYTHING HERE IS BEST-EFFORT BY CONTRACT. Every export that generates
 * resolves to `undefined` on any failure — missing CLI, timeout, refusal,
 * unparseable output — and the caller treats that as "keep the placeholder".
 * A turn must never be lost, delayed, or failed over a naming nicety.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultInstanceIdForDriver, workspacePath, type SessionWorkspace, type TextGenPolicy } from "@telar/engine-client";
import { requireCli } from "./cli-resolution";

export type TextGenEffort = "low" | "medium" | "high";

export type TextGenDriverInput = {
  driver: "claude" | "codex";
  /** The instance's own binary, when configured — same meaning as everywhere. */
  binaryPath?: string;
  /** Extra environment from the provider instance, over the process's own. */
  env?: Record<string, string>;
  /** Where to run. The session's workspace, so a harness that peeks at the
   *  repo sees the right one; nothing here depends on it. */
  cwd: string;
  /** Model id or alias; absent = the harness's own default. */
  model?: string;
  /** Reasoning effort. Defaults to "low" — right for the title job this file
   *  was built around, and overridable by callers whose task is genuinely
   *  harder (the theme designer's 32-colour palette is one). Only the codex
   *  harness has a knob for it; claude ignores it. */
  effort?: TextGenEffort;
  /** Abort from the caller (a closed HTTP request, usually): the child is
   *  killed and the run resolves undefined, same as a timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * Long enough for a cold harness start plus one small completion; short enough
 * that a hung CLI cannot hold a child process for a whole session. t3 code
 * uses 180 s for the same call; titles do not need the margin.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * THE KILL SWITCH — issue #532. `TELAR_TEXTGEN=off` means no generated title,
 * no generated branch name, and no structured one-shot, whatever the stored
 * preference says.
 *
 * READ HERE RATHER THAN IN `getTextGenPolicy`, deliberately: the environment is
 * saying what this PROCESS may spend, not what the person prefers. Folding it
 * into the stored policy would make the settings pane report titles as switched
 * off, and a reader who then switched them "on" would change nothing. So the
 * preference survives untouched and the two callers that can spend a model call
 * consult this on the way past.
 */
export function textGenDisabledByEnv(): boolean {
  return (process.env.TELAR_TEXTGEN ?? "").trim().toLowerCase() === "off";
}

/** The policy as this process may act on it. Both flags, because with titles
 *  off the branch rename is unreachable anyway and saying so is clearer than
 *  leaving a true beside a false that governs it. */
function effectiveTextGenPolicy(policy: TextGenPolicy): TextGenPolicy {
  return textGenDisabledByEnv() ? { ...policy, titles: false, renameBranches: false } : policy;
}

/** The one shape both generations share: a single required string field. */
function oneStringSchema(key: string): object {
  return {
    type: "object",
    properties: { [key]: { type: "string" } },
    required: [key],
    additionalProperties: false,
  };
}

/**
 * The title prompt, adapted from t3 code's `INITIAL_THREAD_TITLE_PROMPT` —
 * the editorial rules are the part worth keeping verbatim, because they are
 * what stops a model from echoing the message back with an ellipsis.
 */
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

/** The message cap t3 code uses; past this a first message is describing
 *  attachments and logs, not the task. */
const MAX_PROMPT_MESSAGE_CHARS = 8_000;

export function buildTitlePrompt(message: string): string {
  return `${TITLE_PROMPT}\n\nUser message:\n${message.slice(0, MAX_PROMPT_MESSAGE_CHARS)}`;
}

/**
 * First line, unwrapped and bounded — the model is asked for 3-8 words but is
 * not trusted to comply. 80 is the cockpit's own seed cap, so a generated
 * title can never be LONGER than the placeholder it replaces.
 */
export function sanitizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!line) return undefined;
  return line.slice(0, 80);
}

/**
 * Whether a session title is still the placeholder a first message seeded.
 *
 * t3 code's `canReplaceThreadTitle`, on Telar's two seeds: the store's own
 * default, or the cockpit's collapsed-and-truncated first message. Anything
 * else was typed by a person — or generated already — and a background job
 * does not overwrite what a person wrote. Checked TWICE by the caller: before
 * spending the call, and again before writing, because a rename can land in
 * the seconds the harness takes.
 */
export function titleIsSeed(title: string, firstMessage: string): boolean {
  const current = title.trim();
  if (current === "New session") return true;
  const seed = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return seed.length > 0 && current === seed;
}

/**
 * One structured one-shot against the chosen harness. Resolves to the decoded
 * object or undefined; never rejects.
 */
async function runStructured(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  try {
    return input.driver === "claude" ? await runClaude(input, prompt, schema) : await runCodex(input, prompt, schema);
  } catch {
    return undefined;
  }
}

/** `claude -p` with `--json-schema` prints one JSON envelope whose
 *  `structured_output` is the schema-shaped answer. Verified against the
 *  installed CLI; the flag set is t3 code's, minus its permission bypass —
 *  a schema-bound print run needs no tools, so denied-by-default is right.
 *
 *  `--no-session-persistence` IS NOT OPTIONAL HERE — issue #532. Claude Code
 *  writes a full transcript for every session including a print-mode one-liner,
 *  and it attaches environment, skill listing and prompt snapshots to each, so
 *  one title cost ~250 KB under `~/.claude/projects/<slug-of-cwd>/` and the
 *  dogfood machine had accumulated 8.2 GB of them. The flag (print mode only,
 *  verified against 2.1.270) means the run is never saved and cannot be
 *  resumed, which is exactly what a title call wants. A CLI too old to know the
 *  flag fails the run, and a failed run keeps the placeholder — the same
 *  best-effort contract as every other failure in this file. */
async function runClaude(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  const executable = requireCli("claude", { ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}) });
  const args = [
    "-p",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    ...(input.model ? ["--model", input.model] : []),
  ];
  const stdout = await runToCompletion(executable, args, input, prompt);
  if (stdout === undefined) return undefined;
  const envelope = parseJson(stdout);
  const structured = envelope?.["structured_output"];
  return typeof structured === "object" && structured !== null ? (structured as Record<string, unknown>) : undefined;
}

/**
 * `codex exec` — NOT the app-server: `--ephemeral` leaves no session behind
 * and `--output-last-message` writes the schema-shaped answer to a file,
 * which sidesteps parsing a stream that mixes reasoning with the result.
 * Read-only sandbox because this call has no business writing anything.
 */
async function runCodex(input: TextGenDriverInput, prompt: string, schema: object): Promise<Record<string, unknown> | undefined> {
  const executable = requireCli("codex", { ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}) });
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

/** Spawn, feed stdin, collect stdout; undefined on non-zero exit, spawn
 *  failure, or timeout (the child is killed — a stuck harness must not outlive
 *  the turn that incidentally started it). */
function runToCompletion(executable: string, args: string[], input: TextGenDriverInput, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve(undefined);
      return;
    }
    // The exact spawn shape `codex/app-server.ts` uses — the tuple literal is
    // what keeps the overload resolvable under BOTH tsconfigs that compile
    // this file (the engine's and the web app's embedded-worker build).
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: { ...processEnv(), ...(input.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Consumed and discarded, not left unread: `codex exec` narrates progress
    // on stderr, and an unread pipe blocks the child once its buffer fills.
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
    // A caller that hung up must not leave a harness burning tokens for two
    // more minutes — the child dies with the request that started it.
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

/** `process.env` minus its `undefined` holes — spawn refuses them. */
function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** A real title for a session whose current one is the truncated first
 *  message. Sanitized; undefined on any failure. */
export async function generateSessionTitle(input: TextGenDriverInput & { message: string }): Promise<string | undefined> {
  const result = await runStructured(input, buildTitlePrompt(input.message), oneStringSchema("title"));
  return sanitizeTitle(result?.["title"]);
}

/**
 * The policy half of a structured call: the driver, its built-in instance, and
 * the model the environment settled on. Shared by `maybeRetitleSession` and
 * `runStructuredForPolicy` so the two cannot drift on WHOSE account pays.
 */
export type StructuredPolicyStore = {
  getTextGenPolicy(): TextGenPolicy;
  resolveProviderInstance(
    instanceId: string,
    driver: "claude" | "codex",
  ): { enabled: boolean; binaryPath?: string; env: { name: string; value: string }[] };
  /** Only `root` is read — somewhere real to run the child from. */
  paths?: { root?: string };
};

/**
 * One structured completion, for a caller that brought its own schema.
 *
 * THE GENERALISATION OF THE TITLE CALL, and deliberately no more than that:
 * same policy, same built-in instance (a background completion must never
 * spend a custom instance's metered account — see `maybeRetitleSession`), same
 * never-throws contract. `undefined` means the harness did not answer; the
 * caller decides whether that is fatal, and the HTTP route above this one
 * turns it into a 502.
 *
 * CWD IS ARBITRARY. A schema-bound `-p` run has no tools and reads no repo, so
 * the engine's own state root — or the system temp dir when there is none — is
 * as good a place to stand as any workspace.
 */
export async function runStructuredForPolicy(
  store: StructuredPolicyStore,
  input: { prompt: string; schema: object; model?: string; effort?: TextGenEffort; signal?: AbortSignal },
): Promise<Record<string, unknown> | undefined> {
  // The environment's switch first: a process told not to generate does not
  // generate, whatever the stored preference or the caller's schema says.
  if (textGenDisabledByEnv()) return undefined;
  let policy: TextGenPolicy;
  let instance: ReturnType<StructuredPolicyStore["resolveProviderInstance"]>;
  try {
    policy = store.getTextGenPolicy();
    // OpenCode cannot run a one-shot schema-bound prompt the way this helper
    // needs: there is no `-p` equivalent.
    if (policy.driver === "opencode") return undefined;
    instance = store.resolveProviderInstance(defaultInstanceIdForDriver(policy.driver), policy.driver);
  } catch {
    return undefined;
  }
  if (!instance.enabled) return undefined;
  const env: Record<string, string> = {};
  for (const variable of instance.env) if (variable.value) env[variable.name] = variable.value;
  const model = input.model ?? policy.model;
  return runStructured(
    {
      driver: policy.driver,
      ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}),
      env,
      cwd: store.paths?.root ?? os.tmpdir(),
      ...(model ? { model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    input.prompt,
    input.schema,
  );
}

/** The slice of `EngineStore` this job needs — an interface so the whole flow
 *  is testable without a daemon or a real harness. */
export type RetitleStore = {
  getTextGenPolicy(): TextGenPolicy;
  getSession(sessionId: string): { title: string; state: string; workspace: SessionWorkspace };
  resolveProviderInstance(
    instanceId: string,
    driver: "claude" | "codex",
  ): { enabled: boolean; binaryPath?: string; env: { name: string; value: string }[] };
  updateSession(sessionId: string, patch: { title: string }): unknown;
  refreshWorktreeBranchFromTitle(sessionId: string): string | undefined | Promise<string | undefined>;
};

/**
 * The whole first-turn flow: policy → seed check → one harness call → guarded
 * write → branch rename. Fired-and-forgotten from the turn route; every early
 * return is a reason the placeholder stays, none of them worth surfacing.
 *
 * RUNS AS THE DRIVER'S BUILT-IN INSTANCE, deliberately not the session's own:
 * the policy names a harness, and a custom instance's metered account should
 * never be spent by a background job its owner cannot see.
 */
export async function maybeRetitleSession(
  store: RetitleStore,
  sessionId: string,
  firstMessage: string,
  /** The harness call, injectable so the flow is testable without one. */
  generate: typeof generateSessionTitle = generateSessionTitle,
): Promise<void> {
  const policy = effectiveTextGenPolicy(store.getTextGenPolicy());
  if (!policy.titles || policy.driver === "opencode") return;
  let session: ReturnType<RetitleStore["getSession"]>;
  try {
    session = store.getSession(sessionId);
  } catch {
    return;
  }
  if (session.state !== "active" || !titleIsSeed(session.title, firstMessage)) return;
  /**
   * A SESSION WITH NO DIRECTORY KEEPS ITS PLACEHOLDER. The title is written by
   * spawning a CLI, and a CLI has to be spawned somewhere; there is no honest
   * answer for a `none` workspace, and the engine's own cwd would start a
   * harness inside Telar's application-support folder. Same shape as every
   * other early return here — the seed title stays, and nothing is surfaced.
   */
  const cwd = workspacePath(session.workspace);
  if (cwd === undefined) return;
  const instance = store.resolveProviderInstance(defaultInstanceIdForDriver(policy.driver), policy.driver);
  if (!instance.enabled) return;
  const env: Record<string, string> = {};
  for (const variable of instance.env) if (variable.value) env[variable.name] = variable.value;
  const title = await generate({
    driver: policy.driver,
    ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}),
    env,
    cwd,
    ...(policy.model ? { model: policy.model } : {}),
    message: firstMessage,
  });
  if (title === undefined) return;
  // THE SECOND SEED CHECK. The harness took seconds; a person may have renamed
  // the session in them, and their word beats the model's.
  try {
    const current = store.getSession(sessionId);
    if (current.state !== "active" || !titleIsSeed(current.title, firstMessage) || current.title === title) return;
    store.updateSession(sessionId, { title });
  } catch {
    return;
  }
  if (policy.renameBranches) {
    try {
      await store.refreshWorktreeBranchFromTitle(sessionId);
    } catch {
      // The title stuck; the branch keeping its seed name is cosmetic.
    }
  }
}
