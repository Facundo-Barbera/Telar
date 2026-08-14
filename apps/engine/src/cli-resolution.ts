/**
 * WHERE THE CLIs ACTUALLY ARE, AND WHETHER WE CAN TALK TO THEM.
 *
 * Telar drives two CLIs it does not ship — Claude Code and Codex — and a
 * packaged app is where that stops being a detail. Finder gives an app a
 * minimal environment in which bare `claude` on PATH is simply not there, and
 * the Agent SDK's own fallback is a ~272MB platform binary this app does not
 * bundle. T3 Code makes the same call: its `app.asar` carries the SDK's three
 * JavaScript files and none of the binary, and resolves a real install instead.
 *
 * PORTED FROM `packages/core/src/cli-resolution.ts`, which learned all of this
 * the expensive way, and NOT imported from it: `apps/engine` deliberately does
 * not depend on `@telar/core`. `codex/app-server.ts` already carried a
 * transcription of the candidate order for the same reason and names this
 * module's arrival in its own header. That transcription now delegates here, so
 * there is one candidate list rather than two that can drift.
 *
 * WHAT THE VERSION CHECK IS FOR. The npm wrapper and the CLI speak a control
 * protocol to each other. Claude Code updates itself on its own schedule; this
 * app's wrapper updates when we ship. Unchecked, that drift is silent, and its
 * failure mode is not a clean error — it is protocol-level misbehaviour
 * surfacing as phantom tool cancellations nobody can attribute (a 0.3.204
 * wrapper was once found driving a 2.1.222 CLI). So this resolves the binary AND
 * says whether it is a version we expect to work with.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Which CLI a resolution is about. Also the binary name on every candidate
 *  path below — kept as a field on the spec so a CLI whose binary name differs
 *  from its id would have one place to say so. */
export type CliId = "claude" | "codex";

export type CliStatus =
  /** Resolved, and (where a pairing exists) its version is the one expected. */
  | "ok"
  /** Resolved, same protocol family, different patch. Works in practice; worth
   *  surfacing because it is the first thing to suspect when the control
   *  protocol misbehaves. Only a CLI with a declared pairing reports this. */
  | "drifted"
  /** Resolved, but a different major/minor. Not a compatibility promise. */
  | "incompatible"
  /** Nothing found on any candidate path. */
  | "missing"
  /** Found, but it would not report a version. */
  | "unknown"
  /** Found AND versioned, but the version it pairs with was unreadable, so no
   *  compatibility check was made. Distinct from `unknown` on purpose: one is a
   *  CLI that would not answer, the other is a CLI that answered and had nothing
   *  to be judged against. Conflating them made a settings pane print "it would
   *  not report a version" directly above the version it reported. */
  | "unverified";

export type CliResolution = {
  id: CliId;
  /** Display name, e.g. "Claude Code" — so a surface never has to map ids. */
  label: string;
  status: CliStatus;
  /** Absent only when status is `missing`. */
  path?: string;
  /**
   * `path` with every symlink followed, when it could be read.
   *
   * BOTH ARE KEPT because the two answer different questions and the install
   * detector in `cli-updates.ts` needs each. `~/.local/bin/claude` is a symlink
   * into `~/.local/share/claude/versions/`, and an npm global install is a
   * symlink from a bin directory into `lib/node_modules/` — so the link says
   * where it is invoked from and the target says who put it there.
   */
  realPath?: string;
  /** The CLI's own reported version, e.g. `2.1.222`. */
  version?: string;
  /** What this build pairs with, when such a thing exists. Codex has no wrapper
   *  to derive one from, so it is always absent there — an ABSENT expectation is
   *  a fact a surface states, not a gap it fills in. */
  expected?: string;
  /** Set for every status except `ok` — user-facing and actionable, saying what
   *  to do rather than only what is wrong. */
  message?: string;
};

type CliSpec = {
  id: CliId;
  label: string;
  bin: string;
  /** Env var holding an explicit full path, which wins over everything. */
  overrideEnv: string;
  /** Appended to the `missing` message: what to install, and how. */
  installHint: string;
  /** The version this build pairs with, if the pairing is knowable at all.
   *  Omitted entirely for a CLI Telar speaks to directly. */
  expectedVersion?: () => string | undefined;
  /** Called only when BOTH a detected and an expected version exist. Absent ⇒
   *  any version that reports itself is `ok`: inventing a compatibility rule for
   *  a CLI with no declared pairing would be a guess wearing a verdict's
   *  clothes. */
  verdict?: (found: string, expected: string, executable: string) => { status: CliStatus; message?: string };
};

/**
 * THE CLAUDE PAIRING IS DERIVED, NOT HARDCODED. Wrapper and CLI are versioned
 * differently — wrapper 0.3.224 ships CLI 2.1.224 — but the PATCH component is
 * the same number, and that is the release-train identity. Reading it from the
 * installed wrapper means this updates itself on a dependency bump instead of
 * becoming a constant somebody forgets.
 */
export function expectedClaudeCliVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
    const patch = pkg.version?.split(".")[2];
    return patch ? `2.1.${patch}` : undefined;
  } catch {
    return undefined;
  }
}

const SPECS: Record<CliId, CliSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    overrideEnv: "CLAUDE_CODE_EXECUTABLE",
    installHint:
      "Install Claude Code (https://claude.com/claude-code) and sign in, then restart Telar. " +
      "If it is installed somewhere unusual, set CLAUDE_CODE_EXECUTABLE to its full path.",
    expectedVersion: expectedClaudeCliVersion,
    verdict: (version, expected, executable) => {
      const [major, minor] = version.split(".");
      const [xMajor, xMinor] = expected.split(".");
      if (major !== xMajor || minor !== xMinor) {
        return {
          status: "incompatible",
          message:
            `Claude Code ${version} at ${executable} is not compatible with this build of Telar, ` +
            `which speaks the ${xMajor}.${xMinor}.x control protocol (expects ${expected}). ` +
            "Update Telar, or install a matching Claude Code.",
        };
      }
      if (version !== expected) {
        return {
          status: "drifted",
          message:
            `Claude Code ${version} differs from the ${expected} this build was tested against. ` +
            "This usually works — but if tool calls are cancelled without you refusing them, suspect this first.",
        };
      }
      return { status: "ok" };
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    // Kept as it was before this module existed. An env var is an instruction
    // somebody typed into a shell profile, and renaming one silently stops
    // honouring it.
    overrideEnv: "CODEX_BIN",
    installHint:
      "Install it (https://github.com/openai/codex) and sign in, or set CODEX_BIN to its full path, then retry.",
  },
};

/**
 * The directories on PATH, as a last-resort candidate list.
 *
 * LAST, deliberately. PATH is the thing that fails for a Finder-launched app, so
 * it must never shadow an explicit location — but it is also the only reason a
 * CLI installed by npm/nvm/bun (whose bin directory is none of the three below)
 * has ever worked.
 *
 * ABSOLUTE ONLY, and that is not pedantry: a PATH entry of "." or "bin" joins to
 * a bare or cwd-relative name (`path.join(".", "codex") === "codex"`), which is
 * precisely the bare-name spawn this module exists to stop.
 */
const pathCandidates = (bin: string): string[] =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin))
    .filter((candidate) => path.isAbsolute(candidate));

/**
 * Everywhere a binary of this name might be, best first.
 *
 * TAKES A BARE NAME rather than a `CliId` because the CLIs are not the only
 * thing this app has to find. Updating a provider means running its package
 * manager — `npm`, `brew`, `bun` — and a packaged app spawning a bare `npm`
 * fails exactly the way a bare `claude` did, for exactly the same reason. One
 * search order, so a helper cannot be looked for somewhere a CLI would not be.
 */
export function candidatePathsFor(bin: string, override?: string | undefined): string[] {
  return [
    override,
    path.join(os.homedir(), ".local", "bin", bin),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    ...pathCandidates(bin),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function cliCandidatePaths(id: CliId): string[] {
  const spec = SPECS[id];
  return candidatePathsFor(spec.bin, process.env[spec.overrideEnv]);
}

/** The first candidate that exists, or nothing. The un-judged half of
 *  `resolveCli` — used for helpers that have no version to check. */
export function findExecutable(bin: string): string | undefined {
  return candidatePathsFor(bin).find((candidate) => existsSync(candidate));
}

/** The brand name, without resolving anything. For the messages that have to
 *  be written before a resolution exists. */
export function cliLabel(id: CliId): string {
  return SPECS[id].label;
}

/** Keyed on (path, mtime) rather than for the process lifetime, so a CLI that
 *  upgrades ITSELF while Telar runs is noticed on the next turn instead of being
 *  reported at whatever it was at boot. */
const versionCache = new Map<string, string | null>();

/** In-flight async probes, so N concurrent readers of the settings pane spawn
 *  ONE `--version` between them rather than one each. */
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(executable: string): string {
  try {
    return `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    return executable;
  }
}

/**
 * Throw the version cache away.
 *
 * BELT AND BRACES, called after Telar itself updates a CLI. The (path, mtime)
 * key already invalidates itself for every installer seen so far — a new binary
 * has a new mtime, and a retargeted symlink stats through to the new file. But
 * "so far" is doing real work in that sentence: an installer that preserves
 * timestamps would leave this reporting the version it replaced, and the moment
 * that matters most is the one right after an update, when the pane is about to
 * be re-read to prove the update worked.
 */
export function forgetCliVersions(): void {
  versionCache.clear();
}

// `claude --version` says "2.1.222 (Claude Code)"; `codex --version` says
// "codex-cli 0.145.0".
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

/**
 * The same probe, off the event loop.
 *
 * WHY BOTH EXIST. The sync one runs at the moment a turn spawns a provider, in
 * code that is not serving anything else. The async one serves the settings
 * pane's provider probes: a synchronous spawn on the daemon's HTTP loop stalls
 * every other request — including live session streams — for as long as a wedged
 * binary takes to reach the 10s timeout.
 */
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

/** Announced ONCE per process per CLI, not per turn. Which CLI a session is
 *  actually talking to was unknowable before this. */
const announced = new Set<CliId>();

function announce(resolution: CliResolution): void {
  if (announced.has(resolution.id)) return;
  announced.add(resolution.id);
  const where = resolution.path ?? "not found";
  const what = resolution.version ?? "version unknown";
  const against = resolution.expected ? ` (Telar expects ${resolution.expected})` : "";
  console.log(`[telar] ${resolution.label} CLI: ${resolution.status} · ${what}${against} · ${where}`);
  if (resolution.message) console.log(`[telar] ${resolution.label} CLI: ${resolution.message}`);
}

type Located = { kind: "found"; executable: string; expected?: string } | { kind: "settled"; resolution: CliResolution };

function locate(spec: CliSpec): Located {
  const expected = spec.expectedVersion?.();
  const base = { id: spec.id, label: spec.label } as const;

  // AN EXPLICIT OVERRIDE THAT DOES NOT EXIST IS AN ERROR, NOT A HINT. The
  // override env is the escape hatch the install message advertises, so the user
  // most likely to set it is the user least able to notice it being ignored.
  // Treating a typo as merely one more candidate means falling through to a
  // DIFFERENT binary, which then runs — and reports a green "ok" naming a path
  // nobody chose.
  const override = process.env[spec.overrideEnv];
  if (override && !existsSync(override)) {
    return {
      kind: "settled",
      resolution: {
        ...base,
        status: "missing",
        ...(expected ? { expected } : {}),
        message:
          `${spec.overrideEnv} is set to ${override}, but nothing is there. ` +
          `Telar will not silently fall back to a different ${spec.label} than the one you pinned — ` +
          `fix the path or unset ${spec.overrideEnv} to use the usual locations.`,
      },
    };
  }

  const executable = cliCandidatePaths(spec.id).find((candidate) => existsSync(candidate));
  if (!executable) {
    return {
      kind: "settled",
      resolution: {
        ...base,
        status: "missing",
        ...(expected ? { expected } : {}),
        message: `No ${spec.label} installation found. Telar does not bundle one. ${spec.installHint}`,
      },
    };
  }
  return { kind: "found", executable, ...(expected ? { expected } : {}) };
}

// PROBE AND VERDICT ARE SPLIT so the sync and async paths differ in exactly one
// call — the subprocess — and share every judgement. Two copies of the
// classification would be two places for the settings pane and the spawn gate to
// disagree about the same machine.
/** Followed, or nothing — a dangling link is not an error worth failing a
 *  resolution over, it is simply one less thing known about the install. */
function realPathOf(executable: string): { realPath?: string } {
  try {
    const resolved = realpathSync(executable);
    return resolved === executable ? {} : { realPath: resolved };
  } catch {
    return {};
  }
}

function classify(spec: CliSpec, executable: string, version: string | null, expected: string | undefined): CliResolution {
  const base = { id: spec.id, label: spec.label, ...realPathOf(executable) } as const;

  if (!version) {
    return {
      ...base,
      status: "unknown",
      path: executable,
      ...(expected ? { expected } : {}),
      message:
        `Found ${spec.label} at ${executable} but it would not report a version. ` +
        "It may be a broken install, a wrapper script, or not executable by this user.",
    };
  }
  if (!expected) {
    return spec.expectedVersion
      ? {
          ...base,
          status: "unverified",
          path: executable,
          version,
          message:
            `Found ${spec.label} ${version} at ${executable}, but Telar could not read the version it ` +
            "expects to pair with, so no compatibility check was made. The CLI is being used as-is.",
        }
      : { ...base, status: "ok", path: executable, version };
  }

  const verdict = spec.verdict?.(version, expected, executable);
  if (!verdict || verdict.status === "ok") return { ...base, status: "ok", path: executable, version, expected };
  return {
    ...base,
    status: verdict.status,
    path: executable,
    version,
    expected,
    ...(verdict.message ? { message: verdict.message } : {}),
  };
}

/** Where the CLI is, what version it is, and whether that is a version this
 *  build expects to be able to talk to. */
export function resolveCli(id: CliId): CliResolution {
  const spec = SPECS[id];
  const located = locate(spec);
  const resolution =
    located.kind === "settled" ? located.resolution : classify(spec, located.executable, detectVersion(located.executable), located.expected);
  announce(resolution);
  return resolution;
}

/** The same verdict, without blocking the event loop. Shares the cache and the
 *  classification, so the two can report different answers only if the CLI
 *  itself changed between them. */
export async function resolveCliAsync(id: CliId): Promise<CliResolution> {
  const spec = SPECS[id];
  const located = locate(spec);
  if (located.kind === "settled") {
    announce(located.resolution);
    return located.resolution;
  }
  const version = await detectVersionAsync(located.executable);
  const resolution = classify(spec, located.executable, version, located.expected);
  announce(resolution);
  return resolution;
}

/** Whether a turn may proceed. `drifted` and `unknown` pass DELIBERATELY: a hard
 *  gate on every unrecognised version would lock somebody out of their own app
 *  the day a CLI ships a release we have not blessed, and the common case — a
 *  patch ahead — demonstrably works. Only "no CLI at all" and "wrong protocol
 *  family" are refusals: the turn fails, it does not degrade. */
export function cliUsable(resolution: Pick<CliResolution, "status">): boolean {
  return resolution.status !== "missing" && resolution.status !== "incompatible";
}

/**
 * The executable to spawn, or a thrown, ACTIONABLE refusal.
 *
 * The alternative is what both providers used to do in a packaged app — spawn
 * something that is not there and let the failure surface downstream as ENOENT
 * or "app-server exited (code=null)", with nothing anywhere naming the missing
 * install. The message is the resolution's own, so the reader learns what to
 * install rather than an errno.
 */
export function requireCli(id: CliId): string {
  const resolution = resolveCli(id);
  if (!cliUsable(resolution)) {
    throw new Error(resolution.message ?? `No ${SPECS[id].label} installation found.`);
  }
  // Every usable status carries a path — `missing` is the only pathless one and
  // it was just refused.
  return resolution.path ?? SPECS[id].bin;
}
