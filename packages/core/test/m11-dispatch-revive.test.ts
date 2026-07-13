// M11 (adaptive-verification review, finding: unreachable repair). The dispatcher's
// contract-resolution choke point (runWeaveWiring) reads the authored contract via
// readContract, which returns contract:null on ANY validateContract error — and the
// always-on non-runnable-`command` rule is such an error. So an authored contract
// whose ONLY defect is a prose/JS command `expected` (the loom_mrinlb18 live bug)
// read back as null and was DISCARDED for a fresh synthesize BEFORE the 2c/3 repair
// branch could ever run — silently throwing away the human's answerBlocked
// verifyCommand. reviveRepairableAuthored is the divert that keeps that authored
// contract alive (flowing it into the tighten/repair branch) exactly when a
// sanctioned runnable is available. These tests pin the DECISION the divert makes,
// closing the reachability gap the direct tightenAuthoredContract tests could not
// (they bypassed readContract entirely).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTRACT_FILE, readContract, writeBundleFile } from "../src/bundle";
import { reviveRepairableAuthored } from "../src/dispatcher";
import { createLoom, saveLoom } from "../src/looms";
import { createProject } from "../src/manifest";
import { ProjectManifest } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-revive-home-"));
process.env.TELAR_HOME = home;

let repo: string;
let projN = 0;
let projectName: string;

beforeEach(() => {
  process.env.TELAR_HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-revive-"));
  projN++;
  projectName = `m11rev-${projN}`;
  createProject(repo, { name: projectName });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A persisted AUTHORED contract whose one command carries PROSE — the shape
// validateContract now rejects, so readContract returns null on it.
function seedProseCommandContract(loomId: string) {
  writeBundleFile(
    loomId,
    CONTRACT_FILE,
    JSON.stringify({
      version: 1,
      assertions: [
        {
          id: "bun-test-suite-passes",
          description: "the bun test suite passes",
          type: "command",
          expected: "process exits with code 0; all tests green",
          blocker: true,
        },
      ],
    }),
  );
}

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return { ...ProjectManifest.parse({ name: projectName, root: repo }), ...over } as ProjectManifest;
}

describe("reviveRepairableAuthored — the dispatcher divert that makes the 2c/3 repair reachable", () => {
  test("flag ON + a human verifyCommand REVIVES the prose contract (so it flows into the repair branch, not synthesize)", () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    seedProseCommandContract(loom.id);
    // readContract nulls it (the pre-diff false green the finding names).
    const { contract, errors } = readContract(loom.id);
    expect(contract).toBeNull();
    expect(errors.every((e) => e.includes("non-runnable expected"))).toBe(true);

    const revived = reviveRepairableAuthored(
      loom,
      manifest({ adaptiveVerification: true, verifyCommand: "bun test" } as Partial<ProjectManifest>),
      errors,
    );
    // The RAW authored contract is returned (the else-branch tightens+persists it);
    // its command still carries the prose here — repair happens in the tighten branch.
    expect(revived).not.toBeNull();
    expect(revived!.assertions[0]!.id).toBe("bun-test-suite-passes");
  });

  test("flag ON + a matching charter HINT revives too (no verifyCommand needed)", () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.charter = {
      objective: "o",
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
      decomposition: [],
      version: 1,
      proofHints: [{ criterion: "bun-test-suite-passes", run: "bun test" }],
    } as unknown as typeof loom.charter;
    saveLoom(loom);
    seedProseCommandContract(loom.id);
    const { errors } = readContract(loom.id);
    expect(reviveRepairableAuthored(loom, manifest({ adaptiveVerification: true } as Partial<ProjectManifest>), errors)).not.toBeNull();
  });

  test("flag ON but NO sanctioned runnable -> null (synthesize as before; never preserve an unrepairable prose contract)", () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    seedProseCommandContract(loom.id);
    const { errors } = readContract(loom.id);
    expect(reviveRepairableAuthored(loom, manifest({ adaptiveVerification: true } as Partial<ProjectManifest>), errors)).toBeNull();
  });

  test("flag OFF -> null (byte-identical: today's synthesize path)", () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    seedProseCommandContract(loom.id);
    const { errors } = readContract(loom.id);
    const m = manifest({ adaptiveVerification: false, verifyCommand: "bun test" } as Partial<ProjectManifest>);
    expect(reviveRepairableAuthored(loom, m, errors)).toBeNull();
  });

  test("a DIFFERENT defect (not the non-runnable rule) -> null (only the non-runnable-command case is revived)", () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    // A prose-ONLY assertion (no expected/expectedFile) — a different validateContract
    // error, so the revive must decline and let today's synthesize run.
    writeBundleFile(
      loom.id,
      CONTRACT_FILE,
      JSON.stringify({ version: 1, assertions: [{ id: "x", description: "does the thing", type: "command", blocker: true }] }),
    );
    const { errors } = readContract(loom.id);
    const m = manifest({ verifyCommand: "bun test" } as Partial<ProjectManifest>);
    expect(reviveRepairableAuthored(loom, m, errors)).toBeNull();
  });
});
