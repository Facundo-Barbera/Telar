import { OPENCODE_VERSION } from "./version";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { DriverRun } from "../provider-contract";

export type OpenCodeRuntime = { client: OpencodeClient; closed: boolean; close(): void };

/** A session owns its server and credentials; never attach to an arbitrary
 * process found on a familiar port. Children share the owned process group.
 */
export async function startOpenCodeRuntime(input: DriverRun): Promise<OpenCodeRuntime> {
  const password = crypto.randomBytes(32).toString("base64url");
  const env = { ...process.env, ...input.env, OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...JSON.parse(input.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}"), permission: "ask", share: "disabled" }) };
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
