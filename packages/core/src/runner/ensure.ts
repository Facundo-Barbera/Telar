// M5 ensureRunner — orchestrates the pure resolver (resolve.ts) with injected
// I/O to return a LIVE RunnerTransport. The real `spawn(detached).unref()` sits
// behind `spawnFn`; the real health probe behind `fetchFn`; runner.json reads
// behind `fs`. Tests inject all three, so `ensureRunner` is fully exercised
// WITHOUT spawning a process or opening a socket — and the spawn branches are
// proven never to fire on reuse/connect.
import fs from "node:fs";
import { readRunnerJson, type RunnerFs, type RunnerJson } from "./runner-json";
import { resolveRunner } from "./resolve";
import { makeHttpTransport, type FetchFn } from "./http-transport";
import type { RunnerTransport } from "./transport";

export type SpawnFn = (bin: string | null, telarDir: string) => void;

export type EnsureDeps = {
  telarDir: string;
  runnerUrl?: string; // TELAR_RUNNER_URL (connect-only)
  runnerBin?: string; // TELAR_RUNNER_BIN (spawn the bundled artifact)
  fetchFn?: FetchFn; // default global fetch
  fs?: RunnerFs; // default node fs
  spawnFn?: SpawnFn; // REQUIRED for the spawn branches; default is a real detached spawn hook
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

const baseUrlFor = (json: RunnerJson): string => `http://127.0.0.1:${json.port}`;

// Probe GET /health with the bearer token. Any throw / non-ok → false (dead).
async function healthOk(fetchFn: FetchFn, json: RunnerJson): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrlFor(json)}/health`, {
      method: "GET",
      headers: { authorization: `Bearer ${json.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureRunner(deps: EnsureDeps): Promise<RunnerTransport> {
  const io = deps.fs ?? fs;
  const fetchFn = deps.fetchFn ?? (fetch as FetchFn);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? 100;
  const timeout = deps.pollTimeoutMs ?? 10_000;

  const runnerJson = readRunnerJson(deps.telarDir, io);
  const health = runnerJson ? await healthOk(fetchFn, runnerJson) : false;

  const resolution = resolveRunner({
    runnerUrl: deps.runnerUrl,
    runnerBin: deps.runnerBin,
    runnerJson: runnerJson ? { port: runnerJson.port, token: runnerJson.token } : null,
    healthOk: health,
  });

  if (resolution === "connect") {
    // Connect-only: never spawn. Token from runner.json when present (a
    // supervised daemon publishes one), else empty.
    return makeHttpTransport({ baseUrl: deps.runnerUrl!.replace(/\/+$/, ""), token: runnerJson?.token ?? "", fetchFn });
  }

  if (resolution === "reuse") {
    return makeHttpTransport({ baseUrl: baseUrlFor(runnerJson!), token: runnerJson!.token, fetchFn });
  }

  // spawn-bin / spawn-dev: lazy-spawn a detached runner, then poll runner.json
  // + /health until it publishes itself. spawnFn is the ONLY branch that
  // touches a process — tests assert it fires here and nowhere above.
  if (!deps.spawnFn) throw new Error("ensureRunner: spawnFn required to spawn a runner");
  deps.spawnFn(resolution === "spawn-bin" ? deps.runnerBin! : null, deps.telarDir);

  const deadline = Date.now() + timeout;
  for (;;) {
    const json = readRunnerJson(deps.telarDir, io);
    if (json && (await healthOk(fetchFn, json))) {
      return makeHttpTransport({ baseUrl: baseUrlFor(json), token: json.token, fetchFn });
    }
    if (Date.now() >= deadline) throw new Error("ensureRunner: spawned runner did not become healthy in time");
    await sleep(interval);
  }
}
