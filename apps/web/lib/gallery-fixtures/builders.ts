// GALLERY (delete with /gallery) — typed fixture factories for the dev view
// gallery. Every helper returns a REAL @telar/core / component shape (Loom,
// LoomEvent, AttemptRecord, VerificationContract, PanelReport, SpecBundleData,
// InitialChat, …) stamped with the GALLERY_ID_PREFIX so the fetch interceptor
// can recognize (and only ever serve) fixture ids. NEW FILE — no production code
// imports this; nothing here executes core state.
//
// Client-safety / isolation note: this module `import type`s everything from
// "@telar/core" and the two component modules, so it pulls in ZERO runtime code
// from either — it only constructs plain objects. The validation test proves the
// zod-backed nested structures parse against the REAL schemas.
import type {
  AttemptRecord,
  Charter,
  ContractAssertion,
  CriticFinding,
  CriticVerdict,
  Evidence,
  GateResult,
  Loom,
  LoomEvent,
  PanelReport,
  Provenance,
  RepairRound,
  ServersConfig,
  ServiceConfig,
  SubGoal,
  Verdict,
  VerificationContract,
  VerifierReport,
} from "@telar/core";
import type { SpecBundleData } from "@/components/looms/spec-bundle";
import type { InitialChat } from "@/components/session/session-view";

// Every fixture loom.id starts with this. Real ids `loom_<base36>_<rand>` can
// never carry the `gallery__` prefix, so there is no collision and no leak. The
// FROZEN barrel re-exports this from index.ts.
export const GALLERY_ID_PREFIX = "gallery__";

export const galleryId = (slug: string): string => `${GALLERY_ID_PREFIX}${slug}`;

// Deterministic timeline anchor — 2023-11-14T22:13:20Z. NEVER Date.now(): every
// fixture timestamp is BASE + a fixed offset so timelines read sensibly and the
// test is reproducible.
export const BASE_TS = 1_700_000_000_000;
export const at = (offsetSec: number): number => BASE_TS + offsetSec * 1000;

// A tiny 1x1 transparent PNG — backs screenshot Evidence data URIs so the fetch
// interceptor can serve `GET /evidence/<path>` without any real bytes on disk.
export const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Loom envelope + attempts.
// ---------------------------------------------------------------------------

export function makeLoom(p: Partial<Loom> & { id: string }): Loom {
  return {
    project: "finch",
    kind: "custom",
    title: "Untitled loom",
    prompt: "",
    account: "personal",
    state: "queued",
    createdAt: at(0),
    updatedAt: at(600),
    attempts: [],
    error: null,
    ...p,
  };
}

export function makeThread(
  parentId: string,
  subGoalId: string,
  p: Partial<Loom> & { id: string },
): Loom {
  return makeLoom({ ...p, parentLoomId: parentId, subGoalId });
}

export function makeAttempt(p: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    n: 1,
    role: "builder",
    model: "sonnet",
    startedAt: at(120),
    ...p,
  };
}

export function makeVerdict(p: Partial<Verdict> = {}): Verdict {
  return {
    ok: true,
    summary: "Implemented the change and confirmed the acceptance criteria.",
    files_touched: [],
    blocker: null,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Events. deriveGodView reads a specific vocabulary — model those field names
// exactly (see godview.ts eventsToTranscript / deriveDecisionLog / derivePlan).
// ---------------------------------------------------------------------------

export function makeEvent(
  type: string,
  extra: Record<string, unknown> & { ts?: number } = {},
): LoomEvent {
  const { ts, ...rest } = extra;
  return { ts: ts ?? at(100), type, ...rest };
}

// Transcript-lane events (operator lane has no pieceId; a fan-out piece tags
// every event with pieceId).
export const sayEvent = (text: string, ts: number, pieceId?: string): LoomEvent =>
  makeEvent("text", { text, ts, ...(pieceId ? { pieceId } : {}) });

export const toolEvent = (
  name: string,
  input: Record<string, unknown>,
  ts: number,
  pieceId?: string,
): LoomEvent => makeEvent("tool", { name, input, ts, ...(pieceId ? { pieceId } : {}) });

export const toolResultEvent = (
  name: string,
  output: string,
  ok: boolean,
  ts: number,
  pieceId?: string,
): LoomEvent =>
  makeEvent("tool-result", { name, output, ok, ts, ...(pieceId ? { pieceId } : {}) });

export const sessionEvent = (sessionId: string, ts: number, pieceId?: string): LoomEvent =>
  makeEvent("session", { sessionId, ts, ...(pieceId ? { pieceId } : {}) });

export const agentResultEvent = (
  subtype: string,
  turns: number,
  costUsd: number,
  ts: number,
  pieceId?: string,
): LoomEvent =>
  makeEvent("agent-result", { subtype, turns, costUsd, ts, ...(pieceId ? { pieceId } : {}) });

// ---------------------------------------------------------------------------
// Charter + decomposition (zod-validated by Charter.parse in the test).
// ---------------------------------------------------------------------------

export function makeSubGoal(p: Partial<SubGoal> & { id: string; title: string }): SubGoal {
  return {
    detail: "",
    proofStrategy: "verifier-criteria",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...p,
  };
}

export function makeCharter(p: Partial<Charter> = {}): Charter {
  return {
    objective: "Deliver the requested change with an independent, falsifiable proof.",
    proofStrategy: "verifier-criteria",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: {
      maxParallelThreads: 3,
      maxAgents: 12,
      maxCriticAgents: 3,
    },
    decomposition: [],
    version: 1,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Verification Contract + assertions. validateContract() must return [] for
// any contract we attach to a spec — see makeContract's non-live-critic floor.
// ---------------------------------------------------------------------------

export function makeAssertion(
  p: Partial<ContractAssertion> & { id: string; description: string },
): ContractAssertion {
  return {
    type: "live-critic",
    blocker: true,
    ...p,
  };
}

export function makeContract(
  assertions: ContractAssertion[],
  opts: { synthesized?: boolean; version?: number } = {},
): VerificationContract {
  return {
    version: opts.version ?? 1,
    assertions,
    ...(opts.synthesized !== undefined ? { synthesized: opts.synthesized } : {}),
  };
}

// ---------------------------------------------------------------------------
// Critic Panel (zod: PanelReport / CriticVerdict / CriticFinding / Evidence).
// ---------------------------------------------------------------------------

export function makeEvidence(p: Partial<Evidence> & { kind: Evidence["kind"] }): Evidence {
  return {
    label: "",
    ...p,
  };
}

export function makeFinding(
  p: Partial<CriticFinding> & { title: string; detail: string },
): CriticFinding {
  return {
    severity: "major",
    evidence: [],
    ...p,
  };
}

export function makeCritic(
  p: Partial<CriticVerdict> & { lens: string; class: CriticVerdict["class"] },
): CriticVerdict {
  return {
    blocker: true,
    ok: true,
    summary: "",
    findings: [],
    evidence: [],
    ...p,
  };
}

export function makePanel(
  critics: CriticVerdict[],
  opts: Partial<PanelReport> = {},
): PanelReport {
  return {
    url: "http://localhost:4310",
    critics,
    ...opts,
  };
}

// A minimally-green panel: one always-blocker §M.3 floor lens that passed, plus
// any extra lenses the caller supplies. classifyPanelPure(this) === "pass".
export function greenPanel(extra: CriticVerdict[] = [], url = "http://localhost:4310"): PanelReport {
  return makePanel(
    [
      makeCritic({
        lens: "adversarial/edge-cases",
        class: "adversarial",
        blocker: true,
        ok: true,
        summary: "Probed boundary inputs and error paths — every acceptance assertion held.",
      }),
      ...extra,
    ],
    { url },
  );
}

// ---------------------------------------------------------------------------
// Deterministic gates + legacy Verifier report.
// ---------------------------------------------------------------------------

export function makeGate(p: Partial<GateResult> & { name: string; ok: boolean }): GateResult {
  return {
    exitCode: p.ok ? 0 : 1,
    output: "",
    durationMs: 1200,
    timedOut: false,
    ...p,
  };
}

export function makeVerifierReport(
  p: Partial<VerifierReport> & { feature: string },
): VerifierReport {
  return {
    url: "http://localhost:4310",
    ok: true,
    summary: "Drove the feature end-to-end; every criterion passed.",
    criteria: [],
    sessionEvidence: [],
    designFindings: [],
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Auto-repair rounds (RepairRound — TS type, displayed by deriveRepair).
// ---------------------------------------------------------------------------

export function makeRepairRound(
  p: Partial<RepairRound> & { n: number },
): RepairRound {
  const startedAt = p.startedAt ?? at(400 + p.n * 60);
  return {
    failingIds: [],
    passingIds: [],
    verification: "pass",
    costUsd: 0,
    startedAt,
    endedAt: p.endedAt ?? startedAt + 45_000,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Env-review proposal (ServersConfig — zod ServersConfig.parse).
// ---------------------------------------------------------------------------

export function makeService(p: Partial<ServiceConfig> & { command: string }): ServiceConfig {
  return {
    portStrategy: "dynamic",
    dependsOn: [],
    env: {},
    ...p,
  };
}

export function makeServers(p: Partial<ServersConfig> = {}): ServersConfig {
  return {
    version: 1,
    driver: "host-process",
    services: {},
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Provenance (zod Provenance / assertProvenance).
// ---------------------------------------------------------------------------

export function makeProvenance(p: Partial<Provenance> = {}): Provenance {
  return {
    approvedBy: "you",
    humanApprovedAt: at(30),
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Spec Bundle payload (SpecBundleData — the /spec seam response).
// ---------------------------------------------------------------------------

export function makeSpec(p: Partial<SpecBundleData> = {}): SpecBundleData {
  return {
    version: "spec_v1",
    files: [],
    objective: null,
    contract: null,
    contractErrors: [],
    provenance: null,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Steerer / planner chat seed (InitialChat — the /chat seam response).
// ---------------------------------------------------------------------------

export function makeChat(p: Partial<InitialChat> & { id: string }): InitialChat {
  return {
    model: "claude-sonnet-4",
    messages: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    contextTokens: 0,
    ...p,
  };
}
