// D3 (docs/deflag-cut-plan.md APPROVED DECISION D3; docs/PRINCIPLES.md §20-32,§62)
// — the orchestrator's ENVIRONMENT-COMPREHENSION duty, split into an EAGER
// read-only DETECTION pass (mapped at scoping into a FACT record on the charter)
// and the deterministic HEURISTIC-ASKING rails over that record.
//
// The setup module (setup/setup-agent.ts) survives as the WRITE-capable lane
// bring-up the mediation rung invokes at need; THIS module is its READ-ONLY
// comprehension half. Both compose the SAME primitives (resolveServersConfig,
// the deliverable signal) rather than re-implementing env/port/topology logic.
//
// THE MOAT — this NEVER gates dispatch. Detection is a FACT; asking is an OFFER
// (proceed is always valid, the build starts regardless); a missing requirement
// blocks ONLY the verify step, which the orchestrator-mediation rung repairs at
// need. Secrets persist ONLY to the gitignored tier, never telar.yaml.
import fs from "node:fs";
import path from "node:path";
import { resolveServersConfig as resolveServersConfigDefault } from "./servers";
import { deriveDeliverableSignal } from "./deliverable-signal";
import { readSecret as readSecretDefault, writeSecret as writeSecretDefault } from "./secrets";
import { writeManifest as writeManifestDefault } from "./manifest";
import type { Charter, EnvRequirement, ProjectManifest, RequirementClass, RequirementKind, RequirementsRecord } from "./schemas";

// A name looks like a SECRET when it carries a credential marker. A secret is a
// CERTAIN human-only dead-end — no autonomous step can synthesize it.
const SECRET_MARKERS = ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "APIKEY", "API_KEY", "ACCESS_KEY"];
export function looksSecret(name: string): boolean {
  const up = name.toUpperCase();
  if (SECRET_MARKERS.some((m) => up.includes(m))) return true;
  // A bare `*_KEY` / `*KEY` is a credential unless it is a well-known non-secret
  // (nothing common enough to whitelist today — keep the rule simple + strict).
  return /(^|_)KEY$/.test(up);
}

// PURE deterministic RAILS (D3). Secrets/credentials are human-only; a greenfield
// project whose shape is unknown defers; everything else (ports/servers/DBs and
// non-secret env vars) is maybe-resolvable — the engine stands it up or stubs it
// at need and NEVER asks up-front.
export function classifyRequirement(
  kind: RequirementKind,
  name: string,
  opts: { greenfield?: boolean } = {},
): RequirementClass {
  if (kind === "secret" || (kind === "env-var" && looksSecret(name))) return "human-only";
  if (opts.greenfield) return "greenfield-unknown"; // unknown shape → proceed-and-defer
  return "maybe-resolvable"; // ports / dev-server / database / non-secret env
}

// Parse env-var NAMES from a dotenv-style file. Only names matter for detection —
// example files carry placeholder values, never real secrets. Comment/blank
// lines and `export ` prefixes are tolerated; malformed lines are skipped.
function parseEnvNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function readEnvExampleNames(root: string): { name: string; source: string }[] {
  for (const file of [".env.example", ".env.sample", ".env.template"]) {
    try {
      // turbopackIgnore: runtime probe of the target project's .env examples —
      // must not widen Next's output tracing to the whole workspace.
      const text = fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, file), "utf8");
      return parseEnvNames(text).map((name) => ({ name, source: file }));
    } catch {
      // ENOENT — try the next candidate.
    }
  }
  return [];
}

export type DetectDeps = {
  resolveServersConfig?: typeof resolveServersConfigDefault;
  // Env-var names verification will read (default: parse .env.example tiers).
  readEnvNames?: (root: string) => { name: string; source: string }[];
  // Whether a persisted secret already resolves `name` (never-ask-twice).
  readSecret?: typeof readSecretDefault;
  // The ambient process env — a var already exported is satisfied.
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

// EAGER DETECTION (D3). Read-only comprehension over the project the orchestrator
// is already reading at scoping: map what verification will need into the FACT
// record. Bounded synchronous fs reads only — no LLM, no spawn. Every detected
// requirement is stamped `satisfied` when it is already resolvable from a
// persisted tier, so the offer + mediation both honor never-ask-twice.
export function detectRequirements(
  manifest: ProjectManifest,
  charter?: Charter,
  deps: DetectDeps = {},
): RequirementsRecord {
  const resolveServers = deps.resolveServersConfig ?? resolveServersConfigDefault;
  const readEnv = deps.readEnvNames ?? readEnvExampleNames;
  const readSec = deps.readSecret ?? readSecretDefault;
  const env = deps.env ?? process.env;

  // Greenfield oracle: a project with no plannable deliverable signal is a
  // blank slate — a detected-but-unclassifiable requirement proceeds-and-defers.
  const greenfield = deriveDeliverableSignal(manifest.root, charter).plannable === false;

  const requirements: EnvRequirement[] = [];
  const seen = new Set<string>();
  const add = (r: EnvRequirement) => {
    if (seen.has(r.name)) return; // de-dup by key
    seen.add(r.name);
    requirements.push(r);
  };

  // (1) Env vars / secrets the app reads (from .env.example et al).
  for (const { name, source } of readEnv(manifest.root)) {
    const kind: RequirementKind = looksSecret(name) ? "secret" : "env-var";
    const classification = classifyRequirement(kind, name, { greenfield });
    const satisfied =
      classification === "human-only"
        ? !!readSec(name) || !!env[name]
        : !!env[name];
    add({ name, kind, classification, satisfied, source, detail: `verification reads ${name}` });
  }

  // (2) The dev server: a servers recipe or a devCommand makes the lane
  // stand-up-able (satisfied); otherwise it is a maybe-resolvable the mediation
  // rung brings up at need via the setup agent.
  const servers = resolveServers(manifest.root);
  const laneStandable = servers.driver !== "none" || !!manifest.devCommand;
  add({
    name: "dev-server",
    kind: "dev-server",
    classification: classifyRequirement("dev-server", "dev-server", { greenfield }),
    satisfied: laneStandable,
    source: servers.driver !== "none" ? "servers.yaml" : manifest.devCommand ? "telar.yaml:devCommand" : undefined,
    detail: "verification needs the app running to drive it",
  });

  // (3) A database: a declared templateDb (a project FACT) resolves it; else a
  // DATABASE_URL-shaped env var signals one is needed (maybe-resolvable).
  if (manifest.templateDb) {
    add({ name: "database", kind: "database", classification: "maybe-resolvable", satisfied: true, source: "telar.yaml:templateDb", detail: "frozen-lane verify clones the template DB" });
  } else if (requirements.some((r) => /(^|_)(DATABASE|DB|POSTGRES|MYSQL|MONGO)(_|$)/.test(r.name.toUpperCase()))) {
    add({ name: "database", kind: "database", classification: classifyRequirement("database", "database", { greenfield }), satisfied: false, source: "env", detail: "verification needs a database" });
  }

  return { requirements, detectedAt: (deps.now ?? Date.now)() };
}

export type RequirementsOffer = {
  // The human-only, still-unsatisfied requirements batched for OPTIONAL up-front
  // answering at charter-review. NEVER a gate: `proceed` is always valid, the
  // build starts regardless, a missing one blocks only the verify step.
  items: EnvRequirement[];
};

// HEURISTIC ASKING (D3). The ONLY requirements ever offered are human-only
// (secrets/credentials) that are still unsatisfied — maybe-resolvable and
// greenfield-unknown are NEVER asked. Undefined ⇒ nothing to offer (dispatch is
// unaffected either way — the offer is not a gate).
export function buildRequirementsOffer(record?: RequirementsRecord): RequirementsOffer | undefined {
  const items = (record?.requirements ?? []).filter((r) => r.classification === "human-only" && !r.satisfied);
  return items.length ? { items } : undefined;
}

// PURE. The lane-relevant requirements the orchestrator-mediation rung CONSUMES
// when repairing an unviable lane (D3.4): the dev-server / database / port / env
// facts — NEVER a secret (a secret is a human-only dead-end the mediation rung
// cannot resolve; it escalates instead). Only the UNSATISFIED ones are actionable.
export function requirementsForLane(charter?: Charter): EnvRequirement[] {
  return (charter?.requirements?.requirements ?? []).filter((r) => r.kind !== "secret" && !r.satisfied);
}

export type RequirementAnswer = { name: string; value: string };
export type PersistDeps = {
  writeSecret?: typeof writeSecretDefault;
  writeManifest?: typeof writeManifestDefault;
};

// Persist offer answers as PROJECT FACTS via the existing ask-once tiers (D3.3).
// SECRETS route ONLY to the gitignored ~/.telar/credentials.json tier — they
// NEVER touch the committable telar.yaml. A non-secret fact the human volunteered
// (a devCommand for a dev-server requirement) promotes to telar.yaml. Every
// answered requirement is stamped `satisfied` so it is never re-offered/re-asked.
export function persistRequirementAnswers(
  manifest: ProjectManifest,
  record: RequirementsRecord,
  answers: RequirementAnswer[],
  deps: PersistDeps = {},
): RequirementsRecord {
  const writeSec = deps.writeSecret ?? writeSecretDefault;
  const writeMan = deps.writeManifest ?? writeManifestDefault;
  const byName = new Map(record.requirements.map((r) => [r.name, r]));
  const factUpdates: Partial<ProjectManifest> = {};

  for (const a of answers) {
    const req = byName.get(a.name);
    if (!req || !a.value?.trim()) continue;
    if (req.classification === "human-only") {
      // SECRETS ONLY to the gitignored tier — never telar.yaml.
      writeSec(a.name, a.value);
    } else if (req.kind === "dev-server") {
      // A non-secret dev-server fact → the committable manifest.
      factUpdates.devCommand = a.value.trim();
    }
    req.satisfied = true;
  }

  if (Object.keys(factUpdates).length) {
    writeMan(manifest.root, { ...manifest, ...factUpdates });
  }
  return record;
}
