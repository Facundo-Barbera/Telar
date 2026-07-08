// Deterministic verification gates: shell commands whose exit codes decide
// whether an agent's work stands. No model in the loop.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type Gate = { name: string; run: string };

export type GateResult = {
  name: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
};

const OUTPUT_TAIL = 8000;
const DRAIN_GRACE_MS = 1000;

// Trim to the tail without starting mid surrogate pair.
const clip = (s: string) => {
  if (s.length <= OUTPUT_TAIL) return s;
  const t = s.slice(-OUTPUT_TAIL);
  const c = t.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? t.slice(1) : t;
};

export function runGate(gate: Gate, cwd: string, timeoutMs = 300_000): Promise<GateResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = "";
    let timedOut = false;
    let exitCode: number | null | undefined; // set by 'exit'; undefined = still running
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // detached => own process group, so a timeout can kill the command AND its children
    const child = spawn(gate.run, { shell: true, cwd, detached: true });

    // StringDecoder keeps multi-byte UTF-8 sequences intact across chunk boundaries.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    const append = (dec: StringDecoder) => (chunk: Buffer) => {
      output = clip(output + dec.write(chunk));
    };
    child.stdout.on("data", append(outDec));
    child.stderr.on("data", append(errDec));

    const timer = setTimeout(() => {
      if (exitCode !== undefined) return; // already exited; drain grace will settle
      timedOut = true;
      try {
        if (!child.pid) throw new Error("no pid");
        process.kill(-child.pid, "SIGKILL"); // negative pid = whole process group
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      output = clip(output + outDec.end() + errDec.end());
      // Leaked grandchildren may hold our pipe ends open forever — release them.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        name: gate.name,
        ok: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : (exitCode ?? null),
        output,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };
    child.on("error", (err) => {
      output = clip(output + String(err));
      exitCode = null;
      settle();
    });
    // Settle on 'exit' (the real exit code) after a short stream-drain grace:
    // waiting for 'close' hangs when the gate leaks a child that inherits stdio.
    child.on("exit", (code) => {
      exitCode = code;
      graceTimer = setTimeout(settle, DRAIN_GRACE_MS);
    });
    child.on("close", () => settle());
  });
}

// Sequential, and always runs every gate — a full failure picture beats fail-fast
// when the results feed a retry prompt.
export async function runGates(
  gates: Gate[],
  cwd: string,
  onGate?: (r: GateResult) => void,
): Promise<{ ok: boolean; results: GateResult[] }> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const r = await runGate(gate, cwd);
    results.push(r);
    onGate?.(r);
  }
  return { ok: results.every((r) => r.ok), results };
}
