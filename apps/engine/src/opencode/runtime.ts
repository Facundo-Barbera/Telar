import { OPENCODE_VERSION } from "./version";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { BROWSER_BRIEFING } from "../browser/briefing";
import { RUN_BRIEFING } from "../run/briefing";
import { writeOrientationInstructions } from "../orientation";
import type { DriverRun } from "../provider-contract";

export type OpenCodeRuntime = { client: OpencodeClient; closed: boolean; close(): void };

/**
 * WHAT THIS SESSION IS TOLD, in the order the other two drivers say it: the
 * orientation first (where the agent is, gated on the person), then the Main
 * session's role if this is that session, then one paragraph per surface the
 * session actually has.
 *
 * THE TWO GATED ON WHO THIS SESSION IS COME BEFORE THE ONES GATED ON WHAT IT
 * HAS. Orientation and the coordinator briefing both say what this conversation
 * IS; the browser and run paragraphs are tool contracts, and they read in the
 * vocabulary the first two teach.
 *
 * Exported so the per-provider test can assert the set without spawning a
 * server, exactly as `mcpConfiguration` is.
 */
export function openCodeBriefings(input: DriverRun): string[] {
  return [
    ...(input.orientation ? [input.orientation] : []),
    ...(input.mainBriefing ? [input.mainBriefing] : []),
    ...(input.browserSocket ? [BROWSER_BRIEFING] : []),
    ...(input.run ? [RUN_BRIEFING] : []),
  ];
}

/**
 * THE CONFIG THE SERVER IS STARTED WITH.
 *
 * `instructions` IS OPENCODE'S OWN BRIEFING SEAM, and it is the reason this
 * function exists. OpenCode takes no per-turn instructions parameter the way
 * Claude Code's `systemPrompt.append` and Codex's `developerInstructions` do;
 * what its config has is `instructions`, an array of FILES whose contents it
 * prepends. So the briefings have to be a file, and `instructions` is the key —
 * verified against the installed SDK's `Config` type (`instructions?:
 * Array<string>`).
 *
 * APPENDED, NEVER REPLACING. An inbound `OPENCODE_CONFIG_CONTENT` may already
 * carry instructions of the deployment's own; Telar's entry joins that list.
 * And this is `OPENCODE_CONFIG_CONTENT` rather than an edit to the user's
 * `opencode.json`: Telar writes into a file under its OWN root and points at
 * it for the life of one server, so a person's own OpenCode configuration is
 * never touched by having run a Telar session.
 *
 * Exported for the same reason `openCodeBriefings` is — a test reads the config
 * the runtime would have spawned with, rather than its own copy of this.
 */
export function openCodeConfigContent(input: DriverRun, instructionsFile?: string): string {
  const inherited = JSON.parse(input.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    instructions?: unknown;
  };
  const existing = Array.isArray(inherited.instructions) ? (inherited.instructions as string[]) : [];
  const instructions = instructionsFile ? [...existing, instructionsFile] : existing;
  return JSON.stringify({
    ...inherited,
    ...(instructions.length ? { instructions } : {}),
    permission: "ask",
    share: "disabled",
  });
}

/** A session owns its server and credentials; never attach to an arbitrary
 * process found on a familiar port. Children share the owned process group.
 */
export async function startOpenCodeRuntime(input: DriverRun): Promise<OpenCodeRuntime> {
  const password = crypto.randomBytes(32).toString("base64url");
  const briefings = openCodeBriefings(input);
  /**
   * A FILE THAT COULD NOT BE WRITTEN COSTS THE BRIEFINGS, NEVER THE TURN. The
   * paragraph is worth a `/tmp` write; it is not worth a session that will not
   * start because a disk was full.
   */
  const instructionsFile = briefings.length
    ? await writeOrientationInstructions(briefings.join("\n\n")).catch(() => undefined)
    : undefined;
  const env = { ...process.env, ...input.env, OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: openCodeConfigContent(input, instructionsFile) };
  const child = spawn(input.binaryPath ?? "opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
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
      // Drain stderr without leaking prompts, configuration or credentials.
      child.stderr.on("data", () => {});
    });
    const client = createOpencodeClient({ baseUrl: url, directory: input.cwd, throwOnError: true,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    const health = await client.global.health({ throwOnError: true, signal: AbortSignal.timeout(10_000) });
    if (health.data?.version !== OPENCODE_VERSION) throw new Error(`OpenCode ${health.data?.version ?? "unknown"} is not supported by this adapter; install opencode-ai@${OPENCODE_VERSION} or set this provider's binary path to that version.`);
    return { client, get closed() { return closed; }, close };
  } catch (error) { close(); throw error; }
}
