// M11.1 — Modality derivation (docs/adaptive-verification.md §3.1, §7/M11.1).
// Proves, hermetically (no LLM, no agent, no spawn — only tmp-dir filesystem
// fixtures the pure deliverable signal reads):
//   - the adaptiveVerification flag models subjectiveRoutingEnabled verbatim
//     (manifest boolean OR TELAR_ADAPTIVE_VERIFY=1)
//   - flag-off (or bare 1-arg caller, even under the env override) EVERY
//     criterion maps live-critic/ALL exactly as weave-contracts.ts today
//   - flag-on, the blanket test-gate tightening fires ONLY under a SANCTION
//     (prompt-fallback criteria — the loom_mrigs3zo_vxgrsr prove-run fix — or
//     an explicit gate-mechanism charter): authored multi-criteria prose over
//     a test-script repo STAYS live-critic, so a pre-existing green suite can
//     never rubber-stamp criteria it says nothing about (credentials, taste)
//   - a CLI criterion with a charter proofHint becomes command+expected (the
//     hint's runnable); a criterion with NO mappable runnable STAYS live-critic
//   - the derivation only TIGHTENS: the exact-gate-name gate stays a gate, a
//     web-shaped deliverable is never blanket-tightened (signal short-circuit),
//     greenfield deferred-gate stays live-critic (no runnable exists today)
//   - subjective:true never rides a derived gate/command; synthesized:true and
//     validateContract-cleanliness are carried on every derived contract
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Charter, validateContract } from "../src/schemas";
import type { Loom } from "../src/looms";

// synthesizeContract itself never touches TELAR_HOME (pure w.r.t. the store),
// but pin it to a sandbox anyway so this file can never write a real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-1-"));
process.env.TELAR_HOME = home;

const { synthesizeContract } = await import("../src/weave-contracts");
const { adaptiveVerificationEnabled } = await import("../src/runner/flag");

const tmpRoots: string[] = [];
function fixtureRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-1-fix-"));
  tmpRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.TELAR_ADAPTIVE_VERIFY;
});

// Deliverable fixtures (one bounded readdir + one package.json parse each —
// exactly what the frozen signal reads).
const libRoot = fixtureRoot({
  "package.json": JSON.stringify({ name: "lib", main: "index.ts", scripts: { test: "bun test" } }),
  "bun.lock": "",
});
const cliRoot = fixtureRoot({
  "package.json": JSON.stringify({ name: "mycli", bin: { mycli: "./cli.js" } }),
});
const webRoot = fixtureRoot({
  "package.json": JSON.stringify({ name: "app", scripts: { dev: "next dev", test: "bun test" } }),
  "bun.lock": "",
});
const dsRoot = fixtureRoot({ "data.csv": "a,b\n1,2\n" });
const emptyRoot = fixtureRoot({});

function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_m11_1",
    project: "p",
    kind: "custom",
    title: "Ship the library",
    prompt: "Implement the arithmetic library end-to-end.",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
}

function charter(overrides: Record<string, unknown> = {}) {
  return Charter.parse({ objective: "o", proofStrategy: "verifier-criteria", scope: {}, budget: {}, ...overrides });
}

const liveCritic = (i: number, text: string) => ({
  id: `synth-${i}`,
  subGoalId: "ALL",
  description: text,
  type: "live-critic",
  observable: text,
  blocker: true,
});

describe("adaptiveVerificationEnabled (flag wire — models subjectiveRoutingEnabled verbatim)", () => {
  test("manifest boolean OR TELAR_ADAPTIVE_VERIFY=1", () => {
    expect(adaptiveVerificationEnabled({})).toBe(false);
    expect(adaptiveVerificationEnabled({ adaptiveVerification: true })).toBe(true);
    expect(adaptiveVerificationEnabled({ adaptiveVerification: false })).toBe(false);
    process.env.TELAR_ADAPTIVE_VERIFY = "1";
    expect(adaptiveVerificationEnabled({})).toBe(true);
    delete process.env.TELAR_ADAPTIVE_VERIFY;
    expect(adaptiveVerificationEnabled({})).toBe(false);
  });
});

describe("flag-off — byte-identical to today's live-critic/ALL mapping", () => {
  test("manifest WITHOUT the flag over a bun-test library still maps every criterion live-critic", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["adds numbers", "parses precedence"] }), {
      root: libRoot,
      gates: [],
    });
    expect(c.synthesized).toBe(true);
    expect(c.assertions).toEqual([liveCritic(0, "adds numbers"), liveCritic(1, "parses precedence")] as never);
  });

  test("bare 1-arg caller stays byte-identical EVEN under the env override (the `manifest ? … : false` guard)", () => {
    process.env.TELAR_ADAPTIVE_VERIFY = "1";
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["adds numbers"] }));
    expect(c.assertions).toEqual([liveCritic(0, "adds numbers")] as never);
  });

  test("a hint-carrying charter is IGNORED flag-off — no tightening leaks past the flag", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["prints usage on --help"],
        charter: charter({ proofHints: [{ criterion: "prints usage on --help", run: "node cli.js --help" }] }),
      }),
      { root: cliRoot },
    );
    expect(c.assertions).toEqual([liveCritic(0, "prints usage on --help")] as never);
  });
});

describe("flag-on — library test-gate derivation fires ONLY under a sanction (the prove-run fix, narrowed)", () => {
  test("zero criteria (greenfield prompt fallback) yields a COMMAND synth-0, not a live-critic synth-0", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: [], prompt: "Build the arithmetic library" }), {
      adaptiveVerification: true,
      root: libRoot,
    });
    expect(c.assertions.length).toBe(1);
    expect(c.assertions[0]!.type).toBe("command");
    expect(c.assertions[0]!.expected).toBe("bun run test");
    expect(c.assertions[0]!.description).toBe("Build the arithmetic library");
  });

  test("authored criteria + an explicit gate-mechanism charter tighten to the lockfile-aware command", () => {
    // The charter DECLARED "prove me by a deterministic gate"
    // (PROOF_TEMPLATES.quickfix.verifyMechanism === "gate") — the same authored
    // trust channel as a proofHint, so the suite may settle these criteria.
    const c = synthesizeContract(
      fakeLoom({ acceptanceCriteria: ["adds numbers", "parses precedence"], charter: charter({ proofStrategy: "quickfix" }) }),
      { adaptiveVerification: true, root: libRoot },
    );
    expect(c.synthesized).toBe(true);
    expect(c.assertions).toEqual([
      { id: "synth-0", subGoalId: "ALL", description: "adds numbers", type: "command", expected: "bun run test", blocker: true },
      { id: "synth-1", subGoalId: "ALL", description: "parses precedence", type: "command", expected: "bun run test", blocker: true },
    ] as never);
    expect(validateContract(c)).toEqual([]);
  });

  test("UNSANCTIONED authored prose over a test-script repo stays live-critic — a green suite never rubber-stamps", () => {
    // The must-fix regression case: credentials-bound and pure-taste criteria
    // of a non-web deliverable with a passing pre-existing suite must NOT
    // become {type:"command", expected:"bun run test"} — the suite proves
    // NOTHING about either criterion. No sanction (authored criteria, no
    // gate-intent charter) ⇒ both keep live-critic and the fail-closed floor
    // (no-target skip → coercion demote) owns them.
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: [
          "syncs records against the PRODUCTION account using real credentials",
          "the dashboard feels premium and polished",
        ],
      }),
      { adaptiveVerification: true, root: libRoot },
    );
    expect(c.assertions).toEqual([
      liveCritic(0, "syncs records against the PRODUCTION account using real credentials"),
      liveCritic(1, "the dashboard feels premium and polished"),
    ] as never);
  });

  test("env override reaches the derivation when a manifest IS passed (prompt fallback sanction)", () => {
    process.env.TELAR_ADAPTIVE_VERIFY = "1";
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: [] }), { root: libRoot });
    expect(c.assertions[0]!.type).toBe("command");
    expect(c.assertions[0]!.expected).toBe("bun run test");
  });
});

describe("flag-on — CLI/DS criteria tighten via charter proofHints; unmappable stays live-critic", () => {
  test("a CLI criterion with a hint becomes command+expected; a hintless one STAYS live-critic", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["prints usage on --help", "handles bad flags gracefully"],
        charter: charter({ proofHints: [{ criterion: "prints usage on --help", run: "node cli.js --help" }] }),
      }),
      { adaptiveVerification: true, root: cliRoot },
    );
    expect(c.assertions).toEqual([
      { id: "synth-0", subGoalId: "ALL", description: "prints usage on --help", type: "command", expected: "node cli.js --help", blocker: true },
      liveCritic(1, "handles bad flags gracefully"),
    ] as never);
    expect(validateContract(c)).toEqual([]);
  });

  test("SubGoal-level hints are collected too", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["exits 2 on unknown flag"],
        charter: charter({
          decomposition: [
            {
              id: "s1",
              title: "t",
              detail: "d",
              proofStrategy: "quickfix",
              required: true,
              proofHints: [{ criterion: "exits 2 on unknown flag", run: "node cli.js --nope; test $? -eq 2" }],
            },
          ],
        }),
      }),
      { adaptiveVerification: true, root: cliRoot },
    );
    expect(c.assertions[0]!.type).toBe("command");
    expect(c.assertions[0]!.expected).toBe("node cli.js --nope; test $? -eq 2");
  });

  test("a DS deliverable without hints stays live-critic; with an eval hint it becomes the eval command", () => {
    const bare = synthesizeContract(fakeLoom({ acceptanceCriteria: ["accuracy >= 0.9 on the holdout"] }), {
      adaptiveVerification: true,
      root: dsRoot,
    });
    expect(bare.assertions).toEqual([liveCritic(0, "accuracy >= 0.9 on the holdout")] as never);

    const hinted = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["accuracy >= 0.9 on the holdout"],
        charter: charter({ proofHints: [{ criterion: "accuracy >= 0.9 on the holdout", run: "python eval.py --min-acc 0.9" }] }),
      }),
      { adaptiveVerification: true, root: dsRoot },
    );
    expect(hinted.assertions[0]!.type).toBe("command");
    expect(hinted.assertions[0]!.expected).toBe("python eval.py --min-acc 0.9");
  });

  test("blank/degenerate hints are inert — never an empty-expected command", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["does the thing"],
        charter: charter({ proofHints: [{ criterion: "does the thing", run: "   " }, { criterion: "  ", run: "echo hi" }] }),
      }),
      { adaptiveVerification: true, root: cliRoot },
    );
    expect(c.assertions).toEqual([liveCritic(0, "does the thing")] as never);
    expect(validateContract(c)).toEqual([]);
  });
});

describe("flag-on — tightening is ONE-DIRECTIONAL and conservative", () => {
  test("an exact-gate-name criterion STAYS a gate (never demoted, never re-routed) while peers tighten", () => {
    // Gate-intent charter = the blanket sanction, so the non-gate peer tightens;
    // the exact-gate-name rule still runs FIRST and keeps "lint" a gate.
    const loom = fakeLoom({ acceptanceCriteria: ["lint", "adds numbers"], charter: charter({ proofStrategy: "quickfix" }) });
    const manifest = { subjectiveRouting: true, adaptiveVerification: true, root: libRoot, gates: [{ name: "lint" }] };
    const on = synthesizeContract(loom, manifest);
    expect(on.assertions[0]).toEqual({ id: "synth-0", subGoalId: "ALL", description: "lint", type: "gate", expected: "lint", blocker: true } as never);
    expect(on.assertions[1]!.type).toBe("command");

    // One-directional: every assertion deterministic flag-OFF is still
    // deterministic flag-ON — nothing ever becomes live-critic.
    const off = synthesizeContract(loom, { subjectiveRouting: true, gates: [{ name: "lint" }] });
    for (let i = 0; i < off.assertions.length; i++) {
      if (off.assertions[i]!.type !== "live-critic") {
        expect(on.assertions[i]!.type).not.toBe("live-critic");
        expect(on.assertions[i]!.type).toBe(off.assertions[i]!.type);
      }
    }
  });

  test("a web-shaped deliverable (dev script) is NEVER blanket-tightened — the signal short-circuit holds", () => {
    // webRoot has BOTH a dev script and a test script: the web shape wins and
    // every criterion keeps today's live-critic (a test gate cannot honestly
    // settle a running-surface criterion).
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["shows a toast", "persists on reload"] }), {
      adaptiveVerification: true,
      root: webRoot,
    });
    expect(c.assertions).toEqual([liveCritic(0, "shows a toast"), liveCritic(1, "persists on reload")] as never);
  });

  test("greenfield deferred-gate (gate-intent charter over zero files) stays live-critic — no fabricated runnable", () => {
    // The signal is plannable (deferred-gate) so M11.0's pre-flight PROCEEDS,
    // but nothing runnable exists TODAY — M11.1 must not invent a command; the
    // establishing seam (M11.2) re-derives when the artifact appears.
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["adds numbers"], charter: charter({ proofStrategy: "quickfix" }) }), {
      adaptiveVerification: true,
      root: emptyRoot,
    });
    expect(c.assertions).toEqual([liveCritic(0, "adds numbers")] as never);
  });

  test("no root in the options object ⇒ no signal ⇒ no blanket tightening (hints still honored)", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["adds numbers", "prints usage on --help"],
        charter: charter({ proofHints: [{ criterion: "prints usage on --help", run: "node cli.js --help" }] }),
      }),
      { adaptiveVerification: true },
    );
    expect(c.assertions[0]).toEqual(liveCritic(0, "adds numbers") as never);
    expect(c.assertions[1]!.type).toBe("command");
  });
});

describe("flag-on — the verdict-floor rules ride along", () => {
  test("subjective never rides a derived gate/command; synthesized stays carried; contract validates", () => {
    const c = synthesizeContract(
      fakeLoom({
        acceptanceCriteria: ["adds numbers", "feels premium"],
        charter: charter({ proofHints: [{ criterion: "adds numbers", run: "bun test" }] }),
      }),
      { adaptiveVerification: true, root: libRoot },
    );
    expect(c.synthesized).toBe(true);
    for (const a of c.assertions) {
      if (a.type !== "live-critic") expect(a.subjective).toBeUndefined();
    }
    expect(validateContract(c)).toEqual([]);
  });
});
