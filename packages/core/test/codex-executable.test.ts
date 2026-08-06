// @ts-expect-error no @types/bun in this workspace
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  cliCandidatePaths,
  cliUsable,
  requireCli,
  resolveCli,
  type CliResolution,
  type CliSpec,
} from "../src/cli-resolution";
import { codexCliUsable, codexExecutablePath, resolveCodexCli } from "../src/codex-executable";

// These pin the DECISIONS, not this machine. resolveCodexCli() reads the real
// filesystem and runs the real binary, so anything asserting a specific version
// would fail on the next Codex auto-update — which is precisely the drift these
// modules exist to notice.

const CODEX_SPEC: CliSpec = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  overrideEnv: "CODEX_BIN",
  installHint: "irrelevant to path resolution",
};

describe("cliCandidatePaths", () => {
  test("looks in ~/.local/bin — THE BUG", () => {
    // The old resolver checked CODEX_BIN, then /opt/homebrew/bin, then gave up
    // and spawned a bare "codex" off PATH. ~/.local/bin is where the official
    // standalone installer puts it, so the most ordinary install resolved
    // through PATH — which a Finder-launched app does not reliably have. This
    // is the assertion that says the gap is closed.
    expect(cliCandidatePaths(CODEX_SPEC)).toContain(
      path.join(os.homedir(), ".local", "bin", "codex"),
    );
  });

  test("checks the same standard locations Claude does, in the same order", () => {
    const candidates = cliCandidatePaths({ ...CODEX_SPEC, overrideEnv: "TELAR_TEST_UNSET_BIN" });
    expect(candidates.slice(0, 3)).toEqual([
      path.join(os.homedir(), ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });

  test("an explicit override env comes first", () => {
    const previous = process.env.CODEX_BIN;
    process.env.CODEX_BIN = "/tmp/telar-test-codex";
    try {
      expect(cliCandidatePaths(CODEX_SPEC)[0]).toBe("/tmp/telar-test-codex");
    } finally {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
    }
  });

  test("PATH is a LAST resort, never a shadow of an explicit location", () => {
    // Load-bearing both ways. PATH has to be in the list at all, because a
    // Codex installed by npm/nvm/bun lives in none of the three directories
    // above and the old resolver's bare "codex" is the only reason it ever
    // worked. And it has to be LAST, because a minimal Finder-launched
    // environment is exactly the case these resolvers exist for — an explicit
    // install location must win.
    const previous = process.env.PATH;
    process.env.PATH = ["/telar-test-a", "/telar-test-b"].join(path.delimiter);
    try {
      const candidates = cliCandidatePaths({ ...CODEX_SPEC, overrideEnv: "TELAR_TEST_UNSET_BIN" });
      expect(candidates.slice(3)).toEqual(["/telar-test-a/codex", "/telar-test-b/codex"]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
});

describe("resolveCodexCli", () => {
  const previousBin = process.env.CODEX_BIN;
  afterEach(() => {
    if (previousBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBin;
  });

  test("reports only the statuses Codex can justify", () => {
    // NO INVENTED COMPATIBILITY RULE. Claude's "drifted"/"incompatible" come
    // from a real, derivable pairing — the npm wrapper telar depends on ships a
    // matching CLI. Telar speaks to Codex directly over its app-server JSON-RPC
    // with no wrapper in between, so there is no version to expect and nothing
    // to be incompatible with. If a supported range is ever declared, this test
    // is the one that has to be changed on purpose.
    const r = resolveCodexCli();
    expect(["ok", "missing", "unknown"]).toContain(r.status);
    expect(r.expected).toBeUndefined();
  });

  test("identifies itself, so one surface can report both CLIs", () => {
    const r = resolveCodexCli();
    expect(r.id).toBe("codex");
    expect(r.label).toBe("Codex");
  });

  test("carries a path unless nothing was found", () => {
    const r = resolveCodexCli();
    if (r.status === "missing") expect(r.path).toBeUndefined();
    else expect(typeof r.path).toBe("string");
  });

  test("every non-ok status carries an actionable message", () => {
    // A status the user cannot act on is the failure this module replaced: the
    // old resolver returned a bare "codex" and the turn died inside a JSON-RPC
    // client as "app-server exited (code=null)", with no attribution at all.
    const r = resolveCodexCli();
    if (r.status !== "ok") expect((r.message ?? "").length).toBeGreaterThan(0);
    // "missing" is the first-run state, so its message has to name both what to
    // install and the escape hatch for an unusual location.
    if (r.status === "missing") expect(r.message).toContain("CODEX_BIN");
  });

  test("is stable across calls (version detection is cached)", () => {
    const a = resolveCodexCli();
    const b = resolveCodexCli();
    expect(b.status).toBe(a.status);
    expect(b.version).toBe(a.version);
    expect(b.path).toBe(a.path);
  });

  test("a CODEX_BIN pointing at nothing REFUSES — it never falls back to another binary", () => {
    // THIS TEST USED TO ASSERT NOTHING on any machine that has Codex: the
    // "missing" branch never ran, leaving only a weak `path !== CODEX_BIN`.
    // The behaviour it named was not implemented either — an override that did
    // not exist was silently dropped, a DIFFERENT Codex ran, and the settings
    // pane reported a green "ok" naming a path the user never chose. That is a
    // regression against the resolver this replaced, which returned the override
    // unconditionally and failed loudly with the bad path in the message.
    //
    // The override is an instruction, not a hint. An instruction telar cannot
    // honour fails (AD-11) — so this now holds on EVERY machine, Codex installed
    // or not, which is what makes it worth having.
    const bogus = path.join(os.tmpdir(), "telar-test-no-such-codex-binary");
    process.env.CODEX_BIN = bogus;
    const r = resolveCodexCli();

    expect(r.status).toBe("missing");
    expect(r.path).toBeUndefined();
    // The message must name the bad path — a refusal the user cannot act on is
    // the failure this whole module replaced.
    expect(r.message).toContain(bogus);
    expect(r.message).toContain("CODEX_BIN");
  });
});

// A CLI THAT IS NOT THERE, deterministically. Neither real CLI can be made
// "missing" from a test — this machine has both, and stubbing homedir/PATH would
// only prove the stub works. A spec for a binary that exists nowhere resolves
// through the same code path on any machine.
//
// It borrows Codex's id because that is the type; the only consequence is that
// the once-per-process announce line prints for this resolution instead of the
// real one, which no assertion depends on.
const ABSENT_CLI: CliSpec = {
  id: "codex",
  label: "Nonexistent Test CLI",
  bin: "telar-test-no-such-cli-binary",
  overrideEnv: "TELAR_TEST_UNSET_BIN",
  installHint: "Install it from nowhere, then restart telar.",
};

describe("a CLI that is not installed", () => {
  test("resolves as missing, with no path and an actionable message", () => {
    const r = resolveCli(ABSENT_CLI);
    expect(r.status).toBe("missing");
    expect(r.path).toBeUndefined();
    expect(r.message).toContain("does not bundle one");
    expect(r.message).toContain(ABSENT_CLI.installHint);
  });

  test("FAILS THE TURN rather than spawning a bare binary name", () => {
    // AD-11, and the whole behavioural change for Codex: the old resolver
    // returned "codex" for this case and let the spawn fail downstream, where
    // the error named a JSON-RPC exit code instead of a missing install.
    expect(() => requireCli(ABSENT_CLI)).toThrow(/Install it from nowhere/);
  });

  test("hands back the resolved path when the CLI IS there", () => {
    // process.execPath is a real, executable file on any machine that can run
    // this test — the override-env candidate is what makes it findable.
    const previous = process.env.TELAR_TEST_UNSET_BIN;
    process.env.TELAR_TEST_UNSET_BIN = process.execPath;
    try {
      expect(requireCli(ABSENT_CLI)).toBe(process.execPath);
    } finally {
      if (previous === undefined) delete process.env.TELAR_TEST_UNSET_BIN;
      else process.env.TELAR_TEST_UNSET_BIN = previous;
    }
  });
});

describe("codexExecutablePath", () => {
  test("returns the same binary resolveCodexCli reports", () => {
    // The gate and the surface must never disagree about which binary a session
    // runs — that disagreement is the whole reason #28 took days.
    const r = resolveCodexCli();
    if (codexCliUsable(r)) expect(codexExecutablePath()).toBe(r.path);
    else expect(() => codexExecutablePath()).toThrow();
  });
});

describe("codexCliUsable", () => {
  const at = (status: CliResolution["status"]): CliResolution => ({
    id: "codex",
    label: "Codex",
    status,
  });

  test("REFUSES THE TURN when no Codex is installed", () => {
    // AD-11: a capability the harness cannot honour fails the turn rather than
    // degrading quietly. Before this, a missing Codex spawned anyway and died
    // as an ENOENT inside the JSON-RPC client.
    expect(codexCliUsable(at("missing"))).toBe(false);
  });

  test("ALLOWS a Codex that would not print its version", () => {
    // "unknown" is a cosmetic probe failure, not a broken harness — the CLI
    // still answers app-server JSON-RPC. Refusing here would lock a user out of
    // a working install.
    expect(codexCliUsable(at("unknown"))).toBe(true);
  });

  test("allows a resolved, versioned Codex", () => {
    expect(codexCliUsable(at("ok"))).toBe(true);
  });

  test("is the same rule Claude is judged by", () => {
    // One gate, not two that drift. If this stops holding, the two providers
    // have started disagreeing about what "usable" means.
    for (const status of ["ok", "drifted", "incompatible", "missing", "unknown"] as const) {
      expect(codexCliUsable(at(status))).toBe(cliUsable({ status }));
    }
  });
});
