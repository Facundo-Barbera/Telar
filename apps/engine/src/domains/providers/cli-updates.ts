import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderUpdateRun } from "@telar/engine-client";
import {
  candidatePathsFor,
  cliLabel,
  findExecutable,
  forgetCliVersions,
  resolveCliAsync,
  type CliId,
  type CliResolution,
} from "./cli";
import { EngineStateError } from "../../state";

const execFileP = promisify(execFile);

type InstallMethod = "native" | "homebrew" | "npm" | "bun" | "pnpm" | "vite-plus" | "unknown";

type UpdateStatus =
  | "current"
  | "behind"
  | "pinned"
  | "unknown";

export type Registry = { kind: "npm"; name: string } | { kind: "homebrew"; cask: string };

type UpdatePlan = {
  method: InstallMethod;
  command: string;
  executable: string;
  args: readonly string[];
  lockKey: string;
};

type CliUpdate = {
  status: UpdateStatus;
  latest?: string;
  method?: InstallMethod;
  command?: string;
};

const NPM_PACKAGE: Record<CliId, string> = {
  opencode: "opencode-ai",
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

const HOMEBREW_CASK: Record<CliId, string> = {
  opencode: "opencode",
  claude: "claude-code",
  codex: "codex",
};

const NATIVE_UPDATE: Record<CliId, readonly string[]> = {
  opencode: ["upgrade"],
  claude: ["update"],
  codex: ["update"],
};

const normalize = (candidate: string): string => candidate.replaceAll("\\", "/").toLowerCase();

const NATIVE_PATHS: Record<CliId, (candidate: string) => boolean> = {
  opencode: (candidate) => candidate.includes("/.opencode/bin/"),
  claude: (candidate) => candidate.endsWith("/.local/bin/claude") || candidate.includes("/.local/share/claude/"),
  codex: (candidate) => candidate.endsWith("/.local/bin/codex") || candidate.includes("/.codex/packages/"),
};

const isBunGlobal = (candidate: string): boolean => candidate.includes("/.bun/bin/");

const isVitePlusGlobal = (candidate: string): boolean => candidate.includes("/.vite-plus/bin/");

const isPnpmGlobal = (candidate: string): boolean =>
  candidate.includes("/.local/share/pnpm/") ||
  candidate.includes("/library/pnpm/") ||
  candidate.includes("/local/share/pnpm/") ||
  candidate.includes("/appdata/local/pnpm/") ||
  candidate.includes("/pnpm/global/");

const isNpmGlobal = (candidate: string): boolean =>
  candidate.includes("/node_modules/.bin/") || candidate.includes("/lib/node_modules/") || candidate.includes("/npm/node_modules/");

const isHomebrew = (candidate: string): boolean =>
  candidate.includes("/cellar/") ||
  candidate.includes("/caskroom/") ||
  candidate.startsWith("/opt/homebrew/bin/") ||
  candidate.startsWith("/usr/local/bin/");

function plan(method: InstallMethod, executable: string, args: readonly string[], lockKey: string): UpdatePlan {
  return { method, command: [executable, ...args].join(" "), executable, args, lockKey };
}

export function updatePlanFor(id: CliId, paths: { path?: string; realPath?: string }): UpdatePlan | undefined {
  if (id === "opencode") return undefined;
  const candidates = [paths.path, paths.realPath].filter((candidate): candidate is string => Boolean(candidate)).map(normalize);
  if (candidates.length === 0) return undefined;

  const native = NATIVE_PATHS[id];
  if (candidates.some(native)) {
    return plan("native", paths.path ?? id, NATIVE_UPDATE[id], `native-${id}`);
  }
  if (candidates.some(isVitePlusGlobal)) return plan("vite-plus", "vp", ["i", "-g", NPM_PACKAGE[id]], "vite-plus-global");
  if (candidates.some(isBunGlobal)) return plan("bun", "bun", ["i", "-g", `${NPM_PACKAGE[id]}@latest`], "bun-global");
  if (candidates.some(isPnpmGlobal)) return plan("pnpm", "pnpm", ["add", "-g", `${NPM_PACKAGE[id]}@latest`], "pnpm-global");
  if (candidates.some(isNpmGlobal)) return plan("npm", "npm", ["install", "-g", `${NPM_PACKAGE[id]}@latest`], "npm-global");
  if (candidates.some(isHomebrew)) return plan("homebrew", "brew", ["upgrade", "--cask", HOMEBREW_CASK[id]], "homebrew");
  return undefined;
}

function registryFor(id: CliId, method: InstallMethod | undefined): Registry {
  return method === "homebrew" ? { kind: "homebrew", cask: HOMEBREW_CASK[id] } : { kind: "npm", name: NPM_PACKAGE[id] };
}

function versionParts(version: string): { numbers: number[]; pre: string } {
  const [core, ...rest] = version.trim().replace(/^v/i, "").split("-");
  return {
    numbers: (core ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: rest.join("-"),
  };
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function updateStatusFor(input: { installed?: string | undefined; latest?: string | undefined; expected?: string | undefined }): UpdateStatus {
  if (!input.installed || !input.latest) return "unknown";
  if (compareVersions(input.installed, input.latest) >= 0) return "current";
  return input.expected && input.installed === input.expected ? "pinned" : "behind";
}

const LATEST_TTL_MS = 60 * 60 * 1_000;

const LATEST_TIMEOUT_MS = 4_000;

const latestCache = new Map<string, { at: number; version: string | null }>();

export function forgetLatestVersions(): void {
  latestCache.clear();
}

function updateChecksEnabled(): boolean {
  return process.env.TELAR_NO_UPDATE_CHECKS !== "1";
}

const cleanVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.split(",")[0]?.trim();
  return trimmed ? trimmed : null;
};

async function fetchLatest(registry: Registry): Promise<string | null> {
  const url =
    registry.kind === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(registry.name)}/latest`
      : `https://formulae.brew.sh/api/cask/${encodeURIComponent(registry.cask)}.json`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
    });
    return response.ok ? cleanVersion(((await response.json()) as { version?: unknown }).version) : null;
  } catch {
    return null;
  }
}

async function latestVersion(
  registry: Registry,
  now: () => number,
  force: boolean,
  fetcher: (registry: Registry) => Promise<string | null>,
): Promise<string | null> {
  const key = registry.kind === "npm" ? `npm:${registry.name}` : `brew:${registry.cask}`;
  const cached = latestCache.get(key);
  if (!force && cached && now() - cached.at < LATEST_TTL_MS) return cached.version;
  const version = await fetcher(registry);
  latestCache.set(key, { at: now(), version });
  return version;
}

type CliUpdateDeps = {
  latest?: (registry: Registry) => Promise<string | null>;
  now?: () => number;
  force?: boolean;
};

export async function cliUpdateFor(resolution: CliResolution, deps: CliUpdateDeps = {}): Promise<CliUpdate> {
  if (resolution.id === "opencode") return { status: "unknown" };
  const now = deps.now ?? Date.now;
  const fetcher = deps.latest ?? fetchLatest;

  const found = updatePlanFor(resolution.id, {
    ...(resolution.path ? { path: resolution.path } : {}),
    ...(resolution.realPath ? { realPath: resolution.realPath } : {}),
  });
  const method = found?.method;

  if (!resolution.version || !updateChecksEnabled()) {
    return { status: "unknown", ...(method ? { method } : {}) };
  }

  const latest = await latestVersion(registryFor(resolution.id, method), now, deps.force === true, fetcher);
  const status = updateStatusFor({
    installed: resolution.version,
    ...(latest ? { latest } : {}),
    ...(resolution.expected ? { expected: resolution.expected } : {}),
  });
  return {
    status,
    ...(latest ? { latest } : {}),
    ...(method ? { method } : {}),
    ...(status === "behind" && found ? { command: found.command } : {}),
  };
}

const RUN_TIMEOUT_MS = 5 * 60_000;

const RUN_OUTPUT_MAX = 10_000;

export type CliUpdateRun = ProviderUpdateRun;

const running = new Set<string>();

const queues = new Map<string, Promise<unknown>>();

function truncate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= RUN_OUTPUT_MAX ? trimmed : `${trimmed.slice(0, RUN_OUTPUT_MAX)}\n…`;
}

function resolveRunner(plan: UpdatePlan): string {
  if (plan.executable.includes("/")) return plan.executable;
  const found = findExecutable(plan.executable);
  if (!found) {
    throw new EngineStateError(
      "invalid_request",
      `Telar could not find \`${plan.executable}\` on this machine, so it cannot run \`${plan.command}\` for you. ` +
        `It looked in ${candidatePathsFor(plan.executable).slice(0, 3).join(", ")} and on PATH. Run the command in your own terminal instead.`,
    );
  }
  return found;
}

async function spawnUpdate(plan: UpdatePlan): Promise<ProviderUpdateRun> {
  const executable = resolveRunner(plan);
  try {
    const { stdout, stderr } = await execFileP(executable, [...plan.args], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 1 << 20,
    });
    const output = truncate(`${stderr}\n\n${stdout}`);
    return {
      ok: true,
      command: plan.command,
      exitCode: 0,
      timedOut: false,
      ...(output ? { output } : {}),
      message: "Updated.",
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    const timedOut = failure.killed === true;
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    const output = truncate(`${failure.stderr ?? ""}\n\n${failure.stdout ?? ""}`);
    return {
      ok: false,
      command: plan.command,
      ...(exitCode === undefined ? {} : { exitCode }),
      timedOut,
      ...(output ? { output } : {}),
      message: timedOut
        ? `\`${plan.command}\` was still running after five minutes and was stopped.`
        : exitCode === undefined
          ? `\`${plan.command}\` could not be run.`
          : `\`${plan.command}\` exited with code ${exitCode}.`,
    };
  }
}

type CliUpdateRunDeps = CliUpdateDeps & {
  binaryPath?: string | undefined;
  resolve?: (id: CliId, options: { binaryPath?: string | undefined }) => Promise<CliResolution>;
  spawn?: (plan: UpdatePlan) => Promise<ProviderUpdateRun>;
};

export async function runCliUpdate(id: CliId, deps: CliUpdateRunDeps = {}): Promise<ProviderUpdateRun> {
  const key = `${id}\u0000${deps.binaryPath ?? ""}`;
  if (running.has(key)) {
    throw new EngineStateError("conflict", `An update of ${cliLabel(id)} is already running.`);
  }
  running.add(key);
  try {
    return await update(id, deps);
  } finally {
    running.delete(key);
  }
}

async function update(id: CliId, deps: CliUpdateRunDeps): Promise<ProviderUpdateRun> {
  const resolution = await (deps.resolve ?? resolveCliAsync)(id, deps.binaryPath ? { binaryPath: deps.binaryPath } : {});
  if (resolution.status === "missing") {
    throw new EngineStateError("invalid_request", resolution.message ?? `No ${id} installation to update.`);
  }

  const advisory = await cliUpdateFor(resolution, deps);
  if (advisory.status === "pinned") {
    throw new EngineStateError(
      "conflict",
      `${resolution.label} ${resolution.version} is exactly the version this build of Telar pairs with. ` +
        `${advisory.latest} exists, but updating would move off the tested pairing — so Telar will not do it for you.`,
    );
  }

  const found = updatePlanFor(id, {
    ...(resolution.path ? { path: resolution.path } : {}),
    ...(resolution.realPath ? { realPath: resolution.realPath } : {}),
  });
  if (!found) {
    throw new EngineStateError(
      "invalid_request",
      `Telar could not tell how ${resolution.label} was installed (${resolution.path}), so it does not know what would update it. ` +
        "Update it the way you installed it.",
    );
  }

  const run = deps.spawn ?? spawnUpdate;
  const previous = queues.get(found.lockKey) ?? Promise.resolve();
  const mine = previous.then(
    () => run(found),
    () => run(found),
  );
  queues.set(
    found.lockKey,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  const result = await mine;
  forgetCliVersions();
  forgetLatestVersions();
  return result;
}
