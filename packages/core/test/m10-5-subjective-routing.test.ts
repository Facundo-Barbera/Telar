// Objective/subjective routing (docs/orchestrator-owned-verification.md §3.6/§6).
// PURE, hermetic: no live agent calls, no filesystem looms. Proves the moat
// invariants directly on the routing/panel/critic seams:
//   (1) an objective machine-checkable criterion (command/gate) routes to the
//       fail-closed GATE, never the blocking panel;
//   (2) an EXPLICITLY subjective-marked criterion is pulled into humanJudged,
//       never agentJudged, so it can never become a blocking panel lens;
//   (3) the advisory aesthetic lens can NEVER flip a panel verdict;
//   (4) an UNMARKED criterion DEFAULTS to objective (stays agent-judged, fail-
//       closed) — a mis-classification/absence never drops an objective criterion.
import { describe, expect, test } from "bun:test";
import type { AgentOpts } from "../src/engine";
import { routeAssertions } from "../src/executor";
import { aggregatePanel, panelSize, type LensSpec, type PanelSignals } from "../src/panel";
import { runCritic, type CriticContext } from "../src/critic";
import { validateContract, type ContractAssertion, type CriticVerdict } from "../src/schemas";

function A(over: Partial<ContractAssertion>): ContractAssertion {
  return { id: "x", description: "d", type: "live-critic", observable: "o", blocker: true, ...over };
}

// A mixed contract: one deterministic gate, one deterministic command, two
// objective agent-judged (unmarked live-critic + a value-equality), one subjective.
const gate = A({ id: "g", type: "gate", expected: "typecheck", observable: undefined });
const cmd = A({ id: "c", type: "command", expected: "bun test", observable: undefined });
const liveObjective = A({ id: "lo", type: "live-critic", observable: "list re-renders after delete" });
const valueObjective = A({ id: "ve", type: "value-equality", expected: "200", observable: undefined });
const subjective = A({ id: "s", type: "live-critic", observable: "feels premium", subjective: true });
const ALL = [gate, cmd, liveObjective, valueObjective, subjective];

describe("routeAssertions — third-bucket subjective routing", () => {
  test("(1) objective machine-checkable criteria route to the deterministic GATE, not the panel", () => {
    const { deterministic, agentJudged } = routeAssertions(ALL);
    // command + gate always settle in the exit-code gate layer, never the panel.
    expect(deterministic.map((a) => a.id).sort()).toEqual(["c", "g"]);
    expect(agentJudged.map((a) => a.id)).not.toContain("g");
    expect(agentJudged.map((a) => a.id)).not.toContain("c");
  });

  test("(1-fix DEFECT-1) a DETERMINISTIC assertion carrying subjective:true STILL gates fail-closed — never pulled into humanJudged", () => {
    // The moat hole: filtering subjective over the WHOLE set before partitioning
    // would drop an exit-code-checkable criterion out of the fail-closed gate.
    // routeAssertions partitions by MODALITY first, so the deterministic slice is
    // NEVER touched by the subjective filter. Marker set on BOTH a gate and a
    // command to cover both deterministic forms. (Red without the reorder fix.)
    const gateSubjective = A({ id: "gs", type: "gate", expected: "typecheck", observable: undefined, subjective: true });
    const cmdSubjective = A({ id: "cs", type: "command", expected: "bun test", observable: undefined, subjective: true });
    const { deterministic, agentJudged, humanJudged } = routeAssertions([gateSubjective, cmdSubjective, liveObjective]);
    // Both deterministic assertions STAY in the fail-closed gate slice.
    expect(deterministic.map((a) => a.id).sort()).toEqual(["cs", "gs"]);
    // and are NEVER carried to the human accept nor left as a blocking panel lens.
    expect(humanJudged.map((a) => a.id)).not.toContain("gs");
    expect(humanJudged.map((a) => a.id)).not.toContain("cs");
    expect(agentJudged.map((a) => a.id)).not.toContain("gs");
    expect(agentJudged.map((a) => a.id)).not.toContain("cs");
    // subjective is pulled ONLY out of the agent-judged remainder (none here).
    expect(humanJudged).toEqual([]);
  });

  test("(2) an explicitly subjective-marked criterion lands in humanJudged, NEVER agentJudged", () => {
    const { agentJudged, humanJudged, deterministic } = routeAssertions(ALL);
    expect(humanJudged.map((a) => a.id)).toEqual(["s"]);
    // Never a blocking panel lens, never a deterministic gate — pulled out entirely.
    expect(agentJudged.map((a) => a.id)).not.toContain("s");
    expect(deterministic.map((a) => a.id)).not.toContain("s");
  });

  test("(2b) objective agent-judged criteria REMAIN in agentJudged ⇒ panelRequired stays true", () => {
    const { agentJudged } = routeAssertions(ALL);
    // the unmarked live-critic + the value kind keep the fail-closed panel alive.
    expect(agentJudged.map((a) => a.id).sort()).toEqual(["lo", "ve"]);
    expect(agentJudged.length > 0).toBe(true); // panelRequired
  });

  test("(2c) a loom whose ONLY judged criteria are subjective ⇒ agentJudged empty ⇒ panel skipped (objective slice alone gates)", () => {
    const onlySubjective = [gate, subjective]; // one objective gate + one subjective
    const { deterministic, agentJudged, humanJudged } = routeAssertions(onlySubjective);
    expect(deterministic.map((a) => a.id)).toEqual(["g"]); // the objective slice
    expect(agentJudged.length).toBe(0); // no blocking panel required
    expect(humanJudged.map((a) => a.id)).toEqual(["s"]); // carried to the human
  });

  test("(4) an UNMARKED live-critic DEFAULTS to objective (stays agent-judged, fail-closed) — absence never drops it from the gate", () => {
    const unmarked = [A({ id: "u", type: "live-critic", observable: "does a thing" })];
    const { agentJudged, humanJudged } = routeAssertions(unmarked);
    expect(agentJudged.map((a) => a.id)).toEqual(["u"]); // fail-closed panel
    expect(humanJudged).toEqual([]); // never silently reclassified
    // subjective:false is treated identically to absent (positive-test only).
    const explicitFalse = [A({ id: "f", subjective: false })];
    expect(routeAssertions(explicitFalse).humanJudged).toEqual([]);
    expect(routeAssertions(explicitFalse).agentJudged.map((a) => a.id)).toEqual(["f"]);
  });
});

const LOW_RISK: PanelSignals = {
  diffLines: 10,
  filesTouched: 1,
  filesOutsideAllowed: 0,
  protectedPathsTouched: false,
  priorFailingCritics: 0,
};
const RISKY: PanelSignals = {
  diffLines: 500, // >= LARGE_DIFF_LINES ⇒ risky ⇒ the UX-relevance signal fires
  filesTouched: 1,
  filesOutsideAllowed: 0,
  protectedPathsTouched: false,
  priorFailingCritics: 0,
};

describe("panelSize — advisory aesthetic lens", () => {
  test("no aesthetic opt ⇒ no aesthetic lens ever sized (the lens is opt-in at the panel layer)", () => {
    expect(panelSize(RISKY, { aesthetic: false })).toEqual(panelSize(RISKY));
    expect(panelSize(RISKY)).toEqual(panelSize(RISKY, undefined));
    expect(panelSize(RISKY).some((l) => l.class === "aesthetic")).toBe(false);
    expect(panelSize(LOW_RISK).some((l) => l.class === "aesthetic")).toBe(false);
  });

  test("aesthetic lens sizes in ONLY under aesthetic:true AND the UX-relevance (risky) signal, always blocker:false", () => {
    // Not risky ⇒ no aesthetic lens even with the opt on.
    expect(panelSize(LOW_RISK, { aesthetic: true }).some((l) => l.class === "aesthetic")).toBe(false);
    // Risky + opt on ⇒ exactly one aesthetic/polish lens, non-blocker.
    const sized = panelSize(RISKY, { aesthetic: true });
    const aesthetic = sized.filter((l) => l.class === "aesthetic");
    expect(aesthetic).toHaveLength(1);
    expect(aesthetic[0]!.lens).toBe("aesthetic/polish");
    expect(aesthetic[0]!.blocker).toBe(false);
  });
});

function V(over: Partial<CriticVerdict> = {}): CriticVerdict {
  return { lens: "l", class: "intent", blocker: false, ok: true, summary: "s", findings: [], evidence: [], ...over };
}
const floor: CriticVerdict = V({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true });

describe("aggregatePanel — the aesthetic lens is provably NON-GATING", () => {
  test("(3) an aesthetic lens with ok:false AND a blocker-severity finding still yields pass=true", () => {
    const aesthetic = V({
      lens: "aesthetic/polish",
      class: "aesthetic",
      blocker: false,
      ok: false, // lies about acceptability
      findings: [{ severity: "blocker", title: "ugly", detail: "d", evidence: [] }], // even a blocker finding
    });
    const res = aggregatePanel([floor, aesthetic]);
    expect(res.pass).toBe(true); // excluded from blockerFindings; not a floor class; blocker:false
    expect(res.blockerFindings).toHaveLength(0);
  });

  test("(narrow relaxation) a NON-aesthetic advisory lens with a blocker-severity finding STILL fails — safety net intact", () => {
    const liveExperience = V({
      lens: "live-experience/ux",
      class: "live-experience",
      blocker: false,
      ok: true,
      findings: [{ severity: "blocker", title: "dead end", detail: "d", evidence: [] }],
    });
    const res = aggregatePanel([floor, liveExperience]);
    expect(res.pass).toBe(false); // the exclusion keys ONLY on class==="aesthetic"
    expect(res.blockerFindings).toHaveLength(1);
  });
});

const ctx: CriticContext = {
  featureName: "checkout",
  url: "http://localhost:3000",
  objective: "buy a thing",
  assertions: [A({ id: "a1", observable: "premium feel" })],
};

describe("runCritic — the aesthetic class/blocker is STAMPED from the LensSpec, not the agent", () => {
  test("(3) a lying aesthetic critic self-reporting adversarial/blocker:true is forced back to aesthetic/blocker:false", async () => {
    const run = (async (_task: string, _opts: AgentOpts<any>) =>
      V({ lens: "whatever", class: "adversarial", blocker: true, ok: false })) as any;
    const lens: LensSpec = { class: "aesthetic", lens: "aesthetic/polish", blocker: false };
    const verdict = await runCritic(lens, ctx, {
      evidenceDir: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "telar-aes-")),
      run,
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.class).toBe("aesthetic"); // stamped, not the agent's "adversarial"
    expect(verdict!.blocker).toBe(false); // stamped, not the agent's true
  });

  test("(3-fix DEFECT-3) a critic spoofing its LENS LABEL has lens stamped back to the LensSpec — evasion of aggregatePanel's missing-sized-blocker net closed", async () => {
    // The agent lies about EVERY authoritative field, including impersonating a
    // DIFFERENT sized blocker lens's label to slip past the missing-lens net,
    // which keys on c.lens === l.lens. lens must come from the LensSpec, not the
    // self-report. (Red without stamping lens: verdict.lens would be the spoof.)
    const run = (async (_task: string, _opts: AgentOpts<any>) =>
      V({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: false })) as any;
    const lens: LensSpec = { class: "aesthetic", lens: "aesthetic/polish", blocker: false };
    const verdict = await runCritic(lens, ctx, {
      evidenceDir: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "telar-spoof-")),
      run,
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.lens).toBe("aesthetic/polish"); // stamped, not the agent's "adversarial/edge" spoof
    expect(verdict!.class).toBe("aesthetic");
    expect(verdict!.blocker).toBe(false);
  });
});

describe("validateContract — DEFECT-2: subjective:true is a live-critic-ONLY marker (defense-in-depth)", () => {
  test("(2-fix) rejects subjective:true on a non-live-critic (gate/command/value) assertion", () => {
    const gateErrs = validateContract({
      assertions: [
        A({ id: "ok", type: "command", expected: "bun test", observable: undefined }),
        A({ id: "badGate", type: "gate", expected: "typecheck", observable: undefined, subjective: true }),
      ],
    });
    expect(gateErrs.some((e) => e.includes("badGate") && e.includes("subjective"))).toBe(true);

    const valueErrs = validateContract({
      assertions: [
        A({ id: "ok", type: "command", expected: "bun test", observable: undefined }),
        A({ id: "badVal", type: "value-equality", expected: "200", observable: undefined, subjective: true }),
      ],
    });
    expect(valueErrs.some((e) => e.includes("badVal") && e.includes("subjective"))).toBe(true);
  });

  test("(2-fix) accepts subjective:true when carried on a type:\"live-critic\" assertion", () => {
    const errs = validateContract({
      assertions: [
        A({ id: "ok", type: "command", expected: "bun test", observable: undefined }),
        A({ id: "sub", type: "live-critic", observable: "feels premium", subjective: true }),
      ],
    });
    expect(errs.some((e) => e.includes("subjective"))).toBe(false);
  });
});
