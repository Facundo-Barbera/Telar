// WHERE AN EXTERNAL CLI ACTUALLY IS, AND WHETHER WE CAN TALK TO IT.
//
// Telar drives two CLIs it does not ship — Claude Code and Codex — and both
// have the same problem: the binary is wherever the user's installer put it,
// and a Finder-launched app gets a minimal environment in which bare `claude`
// or `codex` on PATH is not there. `claude-executable.ts` was written to fix
// exactly that, and its own header records what the fix cost. Codex then went
// and repeated the bug (a two-candidate resolver that never looked in
// ~/.local/bin, the standalone installer's own directory) because the
// resolution lived in the app layer next to the spawn instead of in one place
// both providers could share.
//
// So this is the shared half: candidates, version detection with its cache,
// the announce line, and the usability rule. What is NOT shared is the
// verdict — Claude has an npm wrapper whose version implies a CLI version to
// pair with, and Codex has no wrapper at all, so it gets no compatibility
// vocabulary it cannot justify. A spec supplies its own verdict or gets none.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Which CLI a resolution is about. Also the binary name, on every candidate
 *  path below — kept as a field on the spec anyway so a CLI whose binary name
 *  differs from its id has one place to say so. */
export type CliId = "claude" | "codex";

export type CliStatus =
  /** Resolved, and (where a pairing exists) its version is the one expected. */
  | "ok"
  /** Resolved, same protocol family, different patch. Works in practice; worth
   *  surfacing because it is the first thing to suspect when the control
   *  protocol misbehaves. Only a CLI with a declared pairing reports this. */
  | "drifted"
  /** Resolved, but a different major/minor. Not a compatibility promise. Only a
   *  CLI with a declared pairing reports this. */
  | "incompatible"
  /** Nothing found on any candidate path. */
  | "missing"
  /** Found, but it would not report a version. */
  | "unknown"
  /** Found AND versioned, but telar could not work out which version it expects
   *  to pair with, so no compatibility check was made. Distinct from "unknown"
   *  on purpose: one is a CLI that would not answer, the other is a CLI that
   *  answered and had nothing to be judged against. Conflating them made the
   *  settings pane print "it would not report a version" directly above the
   *  version it reported. Only a CLI that DECLARES a pairing reports this — one
   *  that declares none (Codex) is "ok", because nothing is missing there. */
  | "unverified";

export type CliResolution = {
  id: CliId;
  /** Display name, e.g. "Claude Code" — so a surface never has to map ids. */
  label: string;
  status: CliStatus;
  /** Absent only when status is "missing". */
  path?: string;
  /** The CLI's own reported version, e.g. "2.1.222". */
  version?: string;
  /** What telar was built against, when such a thing exists. Codex has no
   *  wrapper to derive one from, so it is always absent there — an ABSENT
   *  expectation is a fact the surface states, not a gap it fills in. */
  expected?: string;
  /** Set for every status except "ok" — user-facing and actionable, saying what
   *  to do rather than only what is wrong. */
  message?: string;
};

export type CliSpec = {
  id: CliId;
  label: string;
  /** Binary name looked for on the standard candidate directories. */
  bin: string;
  /** Env var holding an explicit full path, which wins over everything. */
  overrideEnv: string;
  /** Appended to the "missing" message: what to install, and how. */
  installHint: string;
  /** The version this build of telar pairs with, if the pairing is knowable.
   *  Omitted entirely for a CLI telar speaks to directly. */
  expectedVersion?: () => string | undefined;
  /** Called only when BOTH a detected and an expected version exist. Absent ⇒
   *  any version that reports itself is "ok": inventing a compatibility rule
   *  for a CLI with no declared pairing would be a guess wearing a verdict's
   *  clothes. */
  verdict?: (found: string, expected: string, executable: string) => {
    status: CliStatus;
    message?: string;
  };
};

/** The directories on PATH, as a last-resort candidate list.
 *
 *  LAST, deliberately. PATH is the thing that fails for a Finder-launched app,
 *  so it must never shadow an explicit location — but it is also the only
 *  reason a Codex installed by npm/nvm/bun (whose bin directory is none of the
 *  three below) has ever worked, because the old resolver ended in a bare
 *  "codex" the OS resolved off PATH. Dropping that silently would fail turns
 *  for installs that work today; keeping it HERE means the path we would run is
 *  one we can also name in a report.
 *
 *  ABSOLUTE ONLY, and that is not pedantry: a PATH entry of "." or "bin" joins
 *  to a bare or cwd-relative name (path.join(".", "codex") === "codex"), which
 *  is precisely the bare-name spawn this module exists to stop — unnameable in
 *  a report, and dependent on whatever directory the process happens to be in.
 *  A relative PATH entry cannot describe an install location, so it is not a
 *  candidate. */
const pathCandidates = (bin: string): string[] =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin))
    .filter((candidate) => path.isAbsolute(candidate));

export const cliCandidatePaths = (spec: CliSpec): string[] =>
  [
    process.env[spec.overrideEnv],
    path.join(os.homedir(), ".local", "bin", spec.bin),
    `/opt/homebrew/bin/${spec.bin}`,
    `/usr/local/bin/${spec.bin}`,
    ...pathCandidates(spec.bin),
  ].filter((c): c is string => Boolean(c));

/** Keyed on (path, mtime) rather than cached for the process lifetime, so a CLI
 *  that upgrades ITSELF while telar runs is noticed on the next turn instead of
 *  being reported at whatever it was at boot. Spawning a subprocess per turn is
 *  the obvious alternative and is a cost every session pays forever. */
const versionCache = new Map<string, string | null>();

/** In-flight async probes, so N concurrent readers of the settings pane spawn
 *  ONE `--version` between them rather than one each. Shares versionCache's key,
 *  so a sync probe that already landed short-circuits before we get here. */
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(executable: string): string {
  try {
    return `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    // Unreadable stat — fall back to the bare path as the key.
    return executable;
  }
}

// Both CLIs print a version containing an x.y.z — `claude --version` says
// "2.1.222 (Claude Code)", `codex --version` says "codex-cli 0.145.0".
const parseVersion = (out: string): string | null => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;

const PROBE = { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 } as const;

function detectVersion(executable: string): string | null {
  const key = cacheKey(executable);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;

  let version: string | null = null;
  try {
    version = parseVersion(execFileSync(executable, ["--version"], {
      ...PROBE,
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

/** The same probe, off the event loop.
 *
 *  WHY BOTH EXIST. The sync one runs once per process at the first turn, in
 *  code paths (engine.ts's agent(), the codex adapter's spawn) that are not
 *  serving anything else and would need to become async all the way up. The
 *  async one exists because /api/clis put this probe on an HTTP handler with a
 *  user-clickable "Re-check": a synchronous spawn there blocks the whole Next
 *  server — every other request, including live SSE chat streams — for as long
 *  as a hung binary takes to hit the timeout. Same cache, same parse, same
 *  verdict (see classify), so the two can report different answers only if the
 *  CLI itself changed underneath them. */
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
 *  actually talking to was unknowable before this — a 0.3.204 wrapper drove a
 *  2.1.222 binary for weeks and nothing anywhere said so, which is most of why
 *  #28 took days. One line at startup makes every later report attributable.
 *
 *  IT IS NOT THE SURFACE. In a packaged app this stdout goes nowhere (the Next
 *  server is a child of the Electron main process), which is why the settings
 *  pane reads the same resolution over /api/clis. */
const announced = new Set<CliId>();

function announce(r: CliResolution): void {
  if (announced.has(r.id)) return;
  announced.add(r.id);
  const where = r.path ?? "not found";
  const what = r.version ? `${r.version}` : "version unknown";
  const against = r.expected ? ` (telar expects ${r.expected})` : "";
  console.log(`[telar] ${r.label} CLI: ${r.status} · ${what}${against} · ${where}`);
  if (r.message) console.log(`[telar] ${r.label} CLI: ${r.message}`);
}

/** The whole answer for one CLI: where it is, what version it is, and — when
 *  telar declares a pairing — whether that is a version we expect to be able to
 *  talk to. */
export function resolveCli(spec: CliSpec): CliResolution {
  const located = locate(spec);
  const resolution =
    located.kind === "settled"
      ? located.resolution
      : classify(spec, located.executable, detectVersion(located.executable), located.expected);
  announce(resolution);
  return resolution;
}

/** The same verdict, without blocking the event loop.
 *
 *  WHY IT EXISTS. `resolveCli` spawns `<cli> --version` synchronously, which is
 *  right in the paths it serves: once per process, at the first turn, in code
 *  that is not serving anything else. It is wrong on an HTTP handler. GET
 *  /api/clis has a user-clickable "Re-check", and a synchronous spawn there
 *  stalls the whole Next server — every other request, including live SSE chat
 *  streams — for as long as a hung binary takes to reach the 10s timeout. This
 *  repo has a recorded failure mode of exactly that shape: the host freezes and
 *  agents start losing tool calls.
 *
 *  It shares versionCache and classify() with the sync path, so the two can
 *  report different answers only if the CLI itself changed between them. */
export async function resolveCliAsync(spec: CliSpec): Promise<CliResolution> {
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

// PROBE AND VERDICT ARE SPLIT so the sync and async paths differ in exactly one
// call — the subprocess — and share every judgement. Two copies of the
// classification would be two places for the settings pane and the spawn gate to
// disagree about the same machine, which is the failure this module exists to
// prevent.
type Located =
  | { kind: "found"; executable: string; expected?: string }
  | { kind: "settled"; resolution: CliResolution };

function locate(spec: CliSpec): Located {
  const expected = spec.expectedVersion?.();
  const base = { id: spec.id, label: spec.label } as const;

  // AN EXPLICIT OVERRIDE THAT DOES NOT EXIST IS AN ERROR, NOT A HINT.
  //
  // The override env is the escape hatch the install message advertises for an
  // unusual location, so the user most likely to set it is the user least able
  // to notice it being ignored. Treating it as merely one more candidate meant a
  // typo fell through to a DIFFERENT binary, which then ran — reported as a
  // green "ok" naming a path the user never chose. That is worse than the old
  // resolver, which returned the override unconditionally and produced a loud
  // ENOENT naming the bad path, and it is a quiet degradation of an instruction
  // telar cannot honour (AD-11). It also defeats this module's whole premise:
  // the surface exists to say which binary a session actually starts.
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
          `telar will not silently fall back to a different ${spec.label} than the one you pinned — ` +
          `fix the path or unset ${spec.overrideEnv} to use the usual locations.`,
      },
    };
  }

  const executable = cliCandidatePaths(spec).find((candidate) => existsSync(candidate));

  if (!executable) {
    return {
      kind: "settled",
      resolution: {
        ...base,
        status: "missing",
        ...(expected ? { expected } : {}),
        message: `No ${spec.label} installation found. telar does not bundle one. ${spec.installHint}`,
      },
    };
  }

  return { kind: "found", executable, ...(expected ? { expected } : {}) };
}

function classify(
  spec: CliSpec,
  executable: string,
  version: string | null,
  expected: string | undefined,
): CliResolution {
  const base = { id: spec.id, label: spec.label } as const;

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
    // Either this CLI declares no pairing at all (Codex), or the pairing was
    // unreadable (Claude's wrapper package.json). Both mean the same thing here:
    // report what was found rather than inventing a verdict.
    // A CLI that DECLARES a pairing but whose expected version was unreadable is
    // `unverified`, not `unknown`: it answered, we simply have nothing to judge
    // it against. Reporting `unknown` here made the settings pane print "it
    // would not report a version" directly above the version it reported.
    // A CLI that declares no pairing (Codex) is `ok` — nothing is missing there.
    return spec.expectedVersion
      ? {
          ...base,
          status: "unverified",
          path: executable,
          version,
          // Every non-ok status owes the reader a message — the pane has nothing
          // else to print, and a bare amber badge beside a perfectly good version
          // is the contradiction this status was split out to end.
          message:
            `Found ${spec.label} ${version} at ${executable}, but telar could not read the ` +
            "version it expects to pair with, so no compatibility check was made. " +
            "The CLI is being used as-is.",
        }
      : { ...base, status: "ok", path: executable, version };
  }

  const verdict = spec.verdict?.(version, expected, executable);
  if (!verdict || verdict.status === "ok") {
    return { ...base, status: "ok", path: executable, version, expected };
  }
  return {
    ...base,
    status: verdict.status,
    path: executable,
    version,
    expected,
    ...(verdict.message ? { message: verdict.message } : {}),
  };
}

/** Whether a turn may proceed. `drifted` and `unknown` pass DELIBERATELY: a hard
 *  gate on every unrecognised version would lock a user out of their own app the
 *  day a CLI ships a release we have not blessed, and the common case — a patch
 *  ahead — demonstrably works. Only "no CLI at all" and "wrong protocol family"
 *  are refusals (AD-11: the turn fails, it does not degrade). */
export function cliUsable(resolution: Pick<CliResolution, "status">): boolean {
  return resolution.status !== "missing" && resolution.status !== "incompatible";
}

/** The executable to spawn, or a thrown, ACTIONABLE refusal.
 *
 *  AD-11 in one function: a harness telar cannot honour fails the turn instead
 *  of degrading. The alternative is what both providers used to do — spawn a
 *  path that isn't there and let the failure surface downstream as ENOENT, or
 *  as "app-server exited (code=null)", with nothing anywhere naming the missing
 *  install. The message is the resolution's own, so the user reads what to
 *  install rather than an errno. */
export function requireCli(spec: CliSpec): string {
  const resolution = resolveCli(spec);
  if (!cliUsable(resolution)) {
    throw new Error(resolution.message ?? `No ${spec.label} installation found.`);
  }
  // Every usable status carries a path — "missing" is the only pathless one and
  // it was just refused. The fallback keeps a spawn possible rather than
  // throwing a TypeError if that ever stops being true.
  return resolution.path ?? spec.bin;
}
