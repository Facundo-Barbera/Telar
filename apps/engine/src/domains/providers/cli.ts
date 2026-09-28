import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { OPENCODE_VERSION, openCodeVersionMessage, openCodeVersionVerdict } from "../../drivers/opencode";

const execFileP = promisify(execFile);

export type CliId = "claude" | "codex" | "opencode";

type CliStatus =
  | "ok"
  | "drifted"
  | "incompatible"
  | "missing"
  | "unknown"
  | "unverified";

export type CliResolution = {
  id: CliId;
  label: string;
  status: CliStatus;
  path?: string;
  realPath?: string;
  version?: string;
  expected?: string;
  message?: string;
};

type CliSpec = {
  id: CliId;
  label: string;
  bin: string;
  overrideEnv: string;
  installHint: string;
  expectedVersion?: () => string | undefined;
  verdict?: (found: string, expected: string) => { status: CliStatus; message?: string };
};

// The SDK and its CLI share a patch number (SDK 0.3.224 ships CLI 2.1.224). Node refuses
// `<sdk>/package.json` (not in `exports`), so walk up from the resolved entry instead.
export function expectedClaudeCliVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    let dir = path.dirname(require_.resolve("@anthropic-ai/claude-agent-sdk"));
    for (let hop = 0; hop < 5; hop += 1) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk") {
          const patch = pkg.version?.split(".")[2];
          return patch ? `2.1.${patch}` : undefined;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const SPECS: Record<CliId, CliSpec> = {
  opencode: { id: "opencode", label: "OpenCode", bin: "opencode", overrideEnv: "OPENCODE_BIN",
    installHint: `Install opencode-ai@${OPENCODE_VERSION} and sign in, or set OPENCODE_BIN to its full path.`,
    expectedVersion: () => OPENCODE_VERSION,
    verdict: (found, expected) => {
      const status = openCodeVersionVerdict(found, expected);
      return status === "ok" ? { status } : { status, message: openCodeVersionMessage(found, expected) };
    } },
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    overrideEnv: "CLAUDE_CODE_EXECUTABLE",
    installHint:
      "Install Claude Code (https://claude.com/claude-code) and sign in, then restart Telar. " +
      "If it is installed somewhere unusual, set CLAUDE_CODE_EXECUTABLE to its full path.",
    expectedVersion: expectedClaudeCliVersion,
    verdict: (version, expected) => {
      const [major, minor] = version.split(".");
      const [xMajor, xMinor] = expected.split(".");
      if (major !== xMajor || minor !== xMinor) {
        return {
          status: "incompatible",
          message: `Needs Claude Code ${xMajor}.${xMinor}.x, found ${version}. Update Telar, or install a matching Claude Code.`,
        };
      }
      if (version !== expected) {
        return {
          status: "drifted",
          message: `Tested against Claude Code ${expected}; you have ${version}. Usually fine — suspect it first if tool calls cancel themselves.`,
        };
      }
      return { status: "ok" };
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    overrideEnv: "CODEX_BIN",
    installHint:
      "Install it (https://github.com/openai/codex) and sign in, or set CODEX_BIN to its full path, then retry.",
  },
};

const pathCandidates = (bin: string): string[] =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin))
    .filter((candidate) => path.isAbsolute(candidate));

const FALLBACK_DIRS = (bin: string): string[] => [
  path.join(os.homedir(), ".local", "bin", bin),
  `/opt/homebrew/bin/${bin}`,
  `/usr/local/bin/${bin}`,
];

export function candidatePathsFor(bin: string, override?: string | undefined): string[] {
  const seen = new Set<string>();
  return [override, ...pathCandidates(bin), ...FALLBACK_DIRS(bin)]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(bin: string): string | undefined {
  return candidatePathsFor(bin).find(isExecutableFile);
}

export function cliLabel(id: CliId): string {
  return SPECS[id].label;
}

const versionCache = new Map<string, string | null>();

const inflight = new Map<string, Promise<string | null>>();

function cacheKey(executable: string): string {
  try {
    return `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    return executable;
  }
}

export function forgetCliVersions(): void {
  versionCache.clear();
}

const parseVersion = (out: string): string | null => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;

const PROBE = { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 } as const;

function detectVersion(executable: string): string | null {
  const key = cacheKey(executable);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  let version: string | null = null;
  try {
    version = parseVersion(execFileSync(executable, ["--version"], { ...PROBE, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

async function detectVersionAsync(executable: string): Promise<string | null> {
  const key = cacheKey(executable);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  const running = inflight.get(key);
  if (running) return running;

  const probe = execFileP(executable, ["--version"], PROBE)
    .then(({ stdout }) => parseVersion(stdout))
    .catch(() => null)
    .then((version) => {
      versionCache.set(key, version);
      inflight.delete(key);
      return version;
    });
  inflight.set(key, probe);
  return probe;
}

const announced = new Set<string>();

function announce(resolution: CliResolution): void {
  const key = `${resolution.id}:${resolution.path ?? "-"}`;
  if (announced.has(key)) return;
  announced.add(key);
  const where = resolution.path ?? "not found";
  const what = resolution.version ?? "version unknown";
  const against = resolution.expected ? ` (Telar expects ${resolution.expected})` : "";
  console.log(`[telar] ${resolution.label} CLI: ${resolution.status} · ${what}${against} · ${where}`);
  if (resolution.message) console.log(`[telar] ${resolution.label} CLI: ${resolution.message}`);
}

type Located =
  | {
      kind: "found";
      executable: string;
      expected?: string;
      alternatives?: string[];
    }
  | { kind: "settled"; resolution: CliResolution };

type Pin = { value: string; what: string; howToClear: string };

const expandHome = (value: string): string => (value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value);

function pinFor(spec: CliSpec, binaryPath: string | undefined): Pin | undefined {
  const own = binaryPath?.trim();
  if (own) {
    return {
      value: expandHome(own),
      what: `This login's binary path is set to ${own}`,
      howToClear: "clear the binary path on this login to use the usual locations",
    };
  }
  const override = process.env[spec.overrideEnv]?.trim();
  if (override) {
    return {
      value: expandHome(override),
      what: `${spec.overrideEnv} is set to ${override}`,
      howToClear: `fix the path or unset ${spec.overrideEnv} to use the usual locations`,
    };
  }
  return undefined;
}

function locate(spec: CliSpec, binaryPath?: string): Located {
  const expected = spec.expectedVersion?.();
  const base = { id: spec.id, label: spec.label } as const;
  const missing = (message: string): Located => ({
    kind: "settled",
    resolution: { ...base, status: "missing", ...(expected ? { expected } : {}), message },
  });

  const pin = pinFor(spec, binaryPath);

  if (pin && (pin.value.includes("/") || pin.value.includes("\\"))) {
    if (!existsSync(pin.value)) {
      return missing(
        `${pin.what}, but nothing is there. ` +
          `Telar will not silently fall back to a different ${spec.label} than the one you pinned — ${pin.howToClear}.`,
      );
    }
    if (!isExecutableFile(pin.value)) {
      return missing(
        `${pin.what}, but it is not an executable file. ` +
          `Check that it is a file rather than a directory and that it has its executable bit (chmod +x), or ${pin.howToClear}.`,
      );
    }
    return { kind: "found", executable: pin.value, ...(expected ? { expected } : {}) };
  }

  const bin = pin?.value ?? spec.bin;
  const [executable, ...alternatives] = candidatePathsFor(bin).filter(isExecutableFile);
  if (!executable) {
    return missing(
      pin
        ? `${pin.what}, and no runnable \`${bin}\` was found on PATH. Use a full path, or ${pin.howToClear}.`
        : `No ${spec.label} installation found. Telar does not bundle one. ${spec.installHint}`,
    );
  }
  return {
    kind: "found",
    executable,
    ...(expected ? { expected } : {}),
    ...(pin || alternatives.length === 0 ? {} : { alternatives }),
  };
}

function alsoFound(spec: CliSpec, alternatives: readonly string[] | undefined): string {
  if (!alternatives?.length) return "";
  const shown = alternatives.slice(0, 3).join(", ");
  const rest = alternatives.length > 3 ? ` (and ${alternatives.length - 3} more)` : "";
  return ` Also on this machine: ${shown}${rest}. Telar uses whichever your PATH finds first; set a binary path below to pick one.`;
}

function realPathOf(executable: string): { realPath?: string } {
  try {
    const resolved = realpathSync(executable);
    return resolved === executable ? {} : { realPath: resolved };
  } catch {
    return {};
  }
}

function classify(
  spec: CliSpec,
  executable: string,
  version: string | null,
  expected: string | undefined,
  alternatives?: readonly string[],
): CliResolution {
  const base = { id: spec.id, label: spec.label, ...realPathOf(executable) } as const;
  const others = alsoFound(spec, alternatives);

  if (!version) {
    return {
      ...base,
      status: "unknown",
      path: executable,
      ...(expected ? { expected } : {}),
      message: `${executable} would not report a version — a broken install, a wrapper script, or not executable by you.${others}`,
    };
  }
  if (!expected) {
    return spec.expectedVersion
      ? {
          ...base,
          status: "unverified",
          path: executable,
          version,
          message: `Using ${spec.label} ${version} unchecked — Telar could not read the version it pairs with.`,
        }
      : { ...base, status: "ok", path: executable, version };
  }

  const verdict = spec.verdict?.(version, expected);
  if (!verdict || verdict.status === "ok") return { ...base, status: "ok", path: executable, version, expected };
  return {
    ...base,
    status: verdict.status,
    path: executable,
    version,
    expected,
    ...(verdict.message ? { message: `${verdict.message}${others}` } : {}),
  };
}

type CliResolveOptions = {
  binaryPath?: string | undefined;
};

export function resolveCli(id: CliId, options: CliResolveOptions = {}): CliResolution {
  const spec = SPECS[id];
  const located = locate(spec, options.binaryPath);
  const resolution =
    located.kind === "settled"
      ? located.resolution
      : classify(spec, located.executable, detectVersion(located.executable), located.expected, located.alternatives);
  announce(resolution);
  return resolution;
}

export async function resolveCliAsync(id: CliId, options: CliResolveOptions = {}): Promise<CliResolution> {
  const spec = SPECS[id];
  const located = locate(spec, options.binaryPath);
  if (located.kind === "settled") {
    announce(located.resolution);
    return located.resolution;
  }
  const version = await detectVersionAsync(located.executable);
  const resolution = classify(spec, located.executable, version, located.expected, located.alternatives);
  announce(resolution);
  return resolution;
}

export function cliUsable(resolution: Pick<CliResolution, "status">): boolean {
  return resolution.status !== "missing" && resolution.status !== "incompatible";
}

export const CLI_TEST_REFUSAL = "refused under NODE_ENV=test: a test must not spawn a real provider (set TELAR_ALLOW_CLI=1 to opt in)";

export function cliSpawnAllowed(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.TELAR_ALLOW_CLI === "1";
}

export function refuseCliSpawnUnderTest(what: string): void {
  if (cliSpawnAllowed()) return;
  throw new Error(`${what} ${CLI_TEST_REFUSAL}`);
}

export function requireCli(id: CliId, options: CliResolveOptions = {}): string {
  refuseCliSpawnUnderTest(SPECS[id].label);
  const resolution = resolveCli(id, options);
  if (!cliUsable(resolution)) {
    throw new Error(resolution.message ?? `No ${SPECS[id].label} installation found.`);
  }
  return resolution.path ?? SPECS[id].bin;
}
