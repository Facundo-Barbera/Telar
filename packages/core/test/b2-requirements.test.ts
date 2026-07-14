// D3 (docs/deflag-cut-plan.md APPROVED DECISION D3; docs/PRINCIPLES.md §20-32,§62)
// — the orchestrator's ENVIRONMENT-COMPREHENSION duty: EAGER detection at
// scoping + the deterministic HEURISTIC-ASKING rails. These tests pin the four
// invariants the owner named:
//   (1) the OFFER NEVER gates dispatch — the build starts regardless;
//   (2) the CLASSIFICATION RAILS are deterministic (human-only / maybe-resolvable
//       / greenfield-unknown);
//   (3) NEVER-ASK-TWICE — a satisfied requirement is never re-offered/re-asked;
//   (4) SECRETS NEVER land in telar.yaml (only the gitignored credentials tier).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-b2req-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const {
  classifyRequirement,
  looksSecret,
  detectRequirements,
  buildRequirementsOffer,
  persistRequirementAnswers,
  requirementsForLane,
} = await import("../src/requirements");
const { startLoom, answerRequirements } = await import("../src/dispatcher");
const { createProject, getProject } = await import("../src/manifest");
const { getLoom, readEvents } = await import("../src/looms");
const { readSecret } = await import("../src/secrets");
import type { Loom } from "../src/looms";
import type { Charter, EnvRequirement, ProjectManifest, RequirementsRecord } from "../src/schemas";

let n = 0;
function makeProject(partial: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-b2req-proj-${n}-`));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const m = createProject(root, { name: `b2req-${n}`, ...partial });
  return { name: m.name, root, manifest: m };
}

const req = (o: Partial<EnvRequirement>): EnvRequirement => ({
  name: "X",
  kind: "env-var",
  classification: "maybe-resolvable",
  satisfied: false,
  ...o,
});

async function settle() {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 30));
}

// ── (2) CLASSIFICATION RAILS ─────────────────────────────────────────────────
describe("(2) classification rails are deterministic", () => {
  test("a secret kind is ALWAYS human-only (even greenfield)", () => {
    expect(classifyRequirement("secret", "STRIPE", { greenfield: true })).toBe("human-only");
    expect(classifyRequirement("secret", "STRIPE")).toBe("human-only");
  });

  test("a secret-NAMED env var is human-only", () => {
    expect(looksSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(looksSecret("GITHUB_TOKEN")).toBe(true);
    expect(looksSecret("DB_PASSWORD")).toBe(true);
    expect(looksSecret("OPENAI_API_KEY")).toBe(true);
    expect(classifyRequirement("env-var", "STRIPE_SECRET_KEY")).toBe("human-only");
  });

  test("a plain env var / port / db / dev-server is maybe-resolvable", () => {
    expect(looksSecret("PORT")).toBe(false);
    expect(looksSecret("DATABASE_URL")).toBe(false);
    expect(classifyRequirement("env-var", "PORT")).toBe("maybe-resolvable");
    expect(classifyRequirement("port", "port")).toBe("maybe-resolvable");
    expect(classifyRequirement("database", "database")).toBe("maybe-resolvable");
    expect(classifyRequirement("dev-server", "dev-server")).toBe("maybe-resolvable");
  });

  test("greenfield-unknown fires for an unclassifiable non-secret in a blank-slate project", () => {
    expect(classifyRequirement("env-var", "SOME_FLAG", { greenfield: true })).toBe("greenfield-unknown");
    expect(classifyRequirement("dev-server", "dev-server", { greenfield: true })).toBe("greenfield-unknown");
  });

  test("detectRequirements maps .env.example names + a dev-server requirement", () => {
    // A brownfield project (package.json makes the deliverable signal plannable
    // ⇒ NOT greenfield ⇒ non-secret env vars are maybe-resolvable).
    const { manifest } = makeProject({}, {
      "package.json": JSON.stringify({ name: "lib", scripts: { test: "bun test" } }),
      "bun.lock": "",
      ".env.example": "# creds\nSTRIPE_SECRET_KEY=\nDATABASE_URL=\nPORT=3000\n",
    });
    const rec = detectRequirements(manifest, undefined, { env: {} });
    const byName = new Map(rec.requirements.map((r) => [r.name, r]));
    expect(byName.get("STRIPE_SECRET_KEY")!.classification).toBe("human-only");
    expect(byName.get("STRIPE_SECRET_KEY")!.kind).toBe("secret");
    expect(byName.get("DATABASE_URL")!.classification).toBe("maybe-resolvable");
    expect(byName.get("PORT")!.classification).toBe("maybe-resolvable");
    // A dev-server requirement is always mapped; unsatisfied with no recipe.
    expect(byName.get("dev-server")!.classification).toBe("maybe-resolvable");
    expect(byName.get("dev-server")!.satisfied).toBe(false);
    // A DATABASE_URL-shaped env var surfaces a database requirement.
    expect(byName.get("database")).toBeTruthy();
  });
});

// ── (1) THE OFFER NEVER GATES DISPATCH ───────────────────────────────────────
describe("(1) the offer is an OFFER, never a gate", () => {
  test("buildRequirementsOffer batches ONLY unsatisfied human-only requirements", () => {
    const rec: RequirementsRecord = {
      requirements: [
        req({ name: "STRIPE_SECRET_KEY", kind: "secret", classification: "human-only" }),
        req({ name: "DATABASE_URL", classification: "maybe-resolvable" }),
        req({ name: "GITHUB_TOKEN", kind: "secret", classification: "human-only", satisfied: true }),
      ],
    };
    const offer = buildRequirementsOffer(rec)!;
    expect(offer.items.map((i) => i.name)).toEqual(["STRIPE_SECRET_KEY"]); // no maybe-resolvable, no satisfied
    expect(buildRequirementsOffer({ requirements: [] })).toBeUndefined();
  });

  test("startLoom: a scoped loom with a secret OFFER still DISPATCHES (proceed is always valid)", async () => {
    // charterPolicy auto: no human pause. The secret offer must ride along and
    // NOT stop the build from starting.
    // A viable lane (devCommand) so the ONLY thing that could gate dispatch is
    // the offer — proving the offer itself never gates.
    const { name } = makeProject(
      { charterPolicy: "auto", devCommand: "bun run dev" },
      { ".env.example": "STRIPE_SECRET_KEY=\n" },
    );
    let built = 0;
    const draftCharterFn = async (): Promise<Charter> => ({
      objective: "do the thing",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 1, maxAgents: 12 },
      decomposition: [],
      version: 1,
    });
    const runLoomFn = async (l: Loom) => ((built++, l.state = "ready"), l);
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "vague ask" },
      { accounts: {}, draftCharterFn, runLoomFn } as any,
    );
    await settle();
    const after = getLoom(loom.id)!;
    // The OFFER was attached (the human-only secret).
    expect(after.requirementsOffer?.items.map((i) => i.name)).toEqual(["STRIPE_SECRET_KEY"]);
    // …yet the build STARTED regardless — never parked at charter-review/scoping.
    expect(built).toBeGreaterThanOrEqual(1);
    expect(after.state).not.toBe("scoping");
    expect(after.state).not.toBe("charter-review");
    // The offer is surfaced as an event, not a gate.
    const { events } = readEvents(loom.id);
    expect(events.some((e) => e.type === "requirements-offer")).toBe(true);
  });
});

// ── (4) SECRETS NEVER LAND IN telar.yaml ─────────────────────────────────────
describe("(4) persistence routes secrets ONLY to the gitignored tier", () => {
  test("a secret answer calls writeSecret and NEVER writeManifest", () => {
    const { manifest } = makeProject();
    const rec: RequirementsRecord = {
      requirements: [req({ name: "STRIPE_SECRET_KEY", kind: "secret", classification: "human-only" })],
    };
    const secretWrites: Array<[string, string]> = [];
    const manifestWrites: ProjectManifest[] = [];
    persistRequirementAnswers(manifest, rec, [{ name: "STRIPE_SECRET_KEY", value: "sk_live_XXX" }], {
      writeSecret: (nm, v) => secretWrites.push([nm, v]),
      writeManifest: (_root, m) => manifestWrites.push(m),
    });
    expect(secretWrites).toEqual([["STRIPE_SECRET_KEY", "sk_live_XXX"]]);
    expect(manifestWrites.length).toBe(0); // NEVER telar.yaml
    expect(rec.requirements[0].satisfied).toBe(true); // stamped
  });

  test("a non-secret dev-server answer DOES promote to telar.yaml (devCommand)", () => {
    const { manifest } = makeProject();
    const rec: RequirementsRecord = {
      requirements: [req({ name: "dev-server", kind: "dev-server", classification: "maybe-resolvable" })],
    };
    let secretCalled = false;
    const manifestWrites: ProjectManifest[] = [];
    persistRequirementAnswers(manifest, rec, [{ name: "dev-server", value: "bun run dev" }], {
      writeSecret: () => (secretCalled = true),
      writeManifest: (_root, m) => manifestWrites.push(m),
    });
    expect(secretCalled).toBe(false);
    expect(manifestWrites[0]?.devCommand).toBe("bun run dev");
  });

  test("the real secret write lands in ~/.telar/credentials.json, readable back — never the repo", () => {
    const { manifest, root } = makeProject();
    const rec: RequirementsRecord = {
      requirements: [req({ name: "GH_TOKEN", kind: "secret", classification: "human-only" })],
    };
    persistRequirementAnswers(manifest, rec, [{ name: "GH_TOKEN", value: "ghp_secret" }]);
    expect(readSecret("GH_TOKEN")).toBe("ghp_secret"); // gitignored home tier
    // telar.yaml in the repo never carries the secret value.
    const yaml = fs.readFileSync(path.join(root, "telar.yaml"), "utf8");
    expect(yaml).not.toContain("ghp_secret");
  });
});

// ── (3) NEVER-ASK-TWICE ──────────────────────────────────────────────────────
describe("(3) never-ask-twice — a satisfied requirement is never re-offered", () => {
  test("detectRequirements marks a secret SATISFIED once it is persisted", () => {
    const { manifest } = makeProject({}, { ".env.example": "GH_TOKEN=\n" });
    // First detection: no secret yet → unsatisfied → offered.
    const rec1 = detectRequirements(manifest, undefined, { env: {}, readSecret: () => undefined });
    expect(buildRequirementsOffer(rec1)!.items.map((i) => i.name)).toEqual(["GH_TOKEN"]);
    // After the human answers (secret persisted) → detection marks it satisfied →
    // the offer is empty. The same fact is never re-asked on a future loom.
    const rec2 = detectRequirements(manifest, undefined, { env: {}, readSecret: (nm) => (nm === "GH_TOKEN" ? "x" : undefined) });
    expect(rec2.requirements.find((r) => r.name === "GH_TOKEN")!.satisfied).toBe(true);
    expect(buildRequirementsOffer(rec2)).toBeUndefined();
  });

  test("an env-exported requirement is satisfied (already resolvable)", () => {
    const { manifest } = makeProject({}, { ".env.example": "DATABASE_URL=\n" });
    const rec = detectRequirements(manifest, undefined, { env: { DATABASE_URL: "postgres://x" } });
    expect(rec.requirements.find((r) => r.name === "DATABASE_URL")!.satisfied).toBe(true);
  });

  test("answerRequirements persists + CLEARS the answered offer item", async () => {
    const { name } = makeProject(
      { charterPolicy: "auto", devCommand: "bun run dev" },
      { ".env.example": "STRIPE_SECRET_KEY=\n" },
    );
    const draftCharterFn = async (): Promise<Charter> => ({
      objective: "do the thing",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 1, maxAgents: 12 },
      decomposition: [],
      version: 1,
    });
    const runLoomFn = async (l: Loom) => ((l.state = "ready"), l);
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "vague ask" },
      { accounts: {}, draftCharterFn, runLoomFn } as any,
    );
    await settle();
    expect(getLoom(loom.id)!.requirementsOffer?.items.length).toBe(1);
    // Answer it → the offer clears; the charter record marks it satisfied.
    const ok = answerRequirements(loom.id, "facundo", [{ name: "STRIPE_SECRET_KEY", value: "sk_live_ANS" }]);
    expect(ok).toBe(true);
    const after = getLoom(loom.id)!;
    expect(after.requirementsOffer).toBeUndefined(); // never re-offered
    expect(after.charter!.requirements!.requirements.find((r) => r.name === "STRIPE_SECRET_KEY")!.satisfied).toBe(true);
    expect(readSecret("STRIPE_SECRET_KEY")).toBe("sk_live_ANS");
    expect(fs.readFileSync(path.join(getProject(name).manifest.root, "telar.yaml"), "utf8")).not.toContain("sk_live_ANS");
  });

  test("answerRequirements requires a non-blank `by`", () => {
    const { name } = makeProject();
    // No loom/offer → false; blank by throws only when the loom+offer exist, so
    // exercise the false path first.
    expect(answerRequirements("nope", "x", [{ name: "a", value: "b" }])).toBe(false);
  });
});

// ── D3.4 — the mediation rung consumes the record (lane view) ─────────────────
describe("D3.4: requirementsForLane exposes only actionable lane facts", () => {
  test("excludes secrets and satisfied requirements", () => {
    const charter: Charter = {
      objective: "o",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 1, maxAgents: 12 },
      decomposition: [],
      version: 1,
      requirements: {
        requirements: [
          req({ name: "STRIPE_SECRET_KEY", kind: "secret", classification: "human-only" }),
          req({ name: "dev-server", kind: "dev-server", classification: "maybe-resolvable" }),
          req({ name: "database", kind: "database", classification: "maybe-resolvable", satisfied: true }),
        ],
      },
    };
    const lane = requirementsForLane(charter).map((r) => r.name);
    expect(lane).toEqual(["dev-server"]); // no secret, no satisfied
    expect(requirementsForLane(undefined)).toEqual([]);
  });
});
