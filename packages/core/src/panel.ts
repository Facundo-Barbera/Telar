// The Critic Panel — §M.3/§M.4 pure invariants (docs/loom-model.md). This is
// the moat's checkable core: PURE functions only, no fs, no agent calls. The
// wiring that actually spawns critic agents and calls verify() lives
// elsewhere (index.ts) and must inject an agent() call here, never embed one.
import type { CriticClass, CriticFinding, CriticVerdict, PanelReport } from "./schemas";
// (all four are types only here — panel.ts never touches the zod schema
// objects themselves, only the shapes they infer)

// Measurable, post-build signals outside planner control (§M.4) — never an
// AI-self-declared risk label. `sizedFrom` on PanelReport is the audit trail
// of exactly these numbers.
export type PanelSignals = {
  diffLines: number;
  filesTouched: number;
  filesOutsideAllowed: number;
  protectedPathsTouched: boolean;
  priorFailingCritics: number;
};

export type LensSpec = { class: CriticClass; lens: string; blocker: boolean };

const LARGE_DIFF_LINES = 400;
const MANY_FILES_TOUCHED = 8;

// panelSize(): the panel's analog of budget.ts:fanoutSize. Deterministic,
// signal-driven scale-up; the §M.3 floor (intent + >=1 adversarial/
// reproduction blocker) is derived here unconditionally, never from a caller
// flag or manifest/session policy — that is what makes it non-negotiable.
// `opts.aesthetic` (M10.5, subjectiveRouting) adds an ADVISORY UX/polish lens
// (blocker:false) UNDER THE SAME UX-relevance signal that sizes live-experience
// (risky). Default undefined ⇒ no aesthetic lens ⇒ byte-identical to every
// existing panelSize(signals) caller/test.
export function panelSize(signals: PanelSignals, opts?: { aesthetic?: boolean }): LensSpec[] {
  const lenses: LensSpec[] = [
    { class: "intent", lens: "intent/acceptance", blocker: true },
    { class: "adversarial", lens: "adversarial/edge", blocker: true },
  ];

  const risky = signals.diffLines >= LARGE_DIFF_LINES || signals.filesTouched >= MANY_FILES_TOUCHED;
  const outOfScope = signals.filesOutsideAllowed > 0 || signals.protectedPathsTouched;
  const hardened = signals.priorFailingCritics > 0;

  if (risky || hardened) {
    lenses.push({ class: "reproduction", lens: "reproduction/cold", blocker: true });
    if (risky) lenses.push({ class: "live-experience", lens: "live-experience/ux", blocker: false });
  }

  // M10.5 — the advisory aesthetic lens rides the SAME UX-relevance signal as
  // live-experience (risky) and is ALWAYS blocker:false. It is provably
  // non-gating (see aggregatePanel below); this only sizes it in.
  if (opts?.aesthetic && risky) {
    lenses.push({ class: "aesthetic", lens: "aesthetic/polish", blocker: false });
  }

  if (outOfScope) {
    lenses.push({ class: "security", lens: "security/scope", blocker: true });
  }

  if (hardened) {
    // A retry hardens the panel: both floor classes must be present as
    // blockers, not just one — dedupe against what risky/hardened already added.
    if (!lenses.some((l) => l.class === "adversarial" && l.blocker)) {
      lenses.push({ class: "adversarial", lens: "adversarial/edge-retry", blocker: true });
    }
    if (!lenses.some((l) => l.class === "reproduction" && l.blocker)) {
      lenses.push({ class: "reproduction", lens: "reproduction/cold-retry", blocker: true });
    }
  }

  return lenses;
}

// aggregatePanel(): §M.3 pure verdict. Two independent conditions must both
// hold to pass — never conflate "the panel that ran was legal" with "the
// panel that ran was clean", both are checked and both are named in `reason`.
// `sized`, when supplied, is the LensSpec[] the panel was ORIGINALLY sized
// to (PanelReport.sized) — it closes the gap where a blocker lens whose
// agent call crashed/never emitted simply vanishes from `critics` (runPanel
// filters nulls out) and would otherwise never be judged at all. Omitting
// `sized` preserves the exact pre-existing behavior (present-critics-only).
export function aggregatePanel(
  critics: CriticVerdict[],
  sized?: LensSpec[],
): {
  pass: boolean;
  blockerFindings: CriticFinding[];
  reason: string;
} {
  // M10.5 — the ONLY relaxation, keyed NARROWLY on class==="aesthetic" (stamped
  // from the LensSpec by runCritic, never the agent's self-report): an advisory
  // aesthetic lens's blocker-severity findings are excluded from the sweep so it
  // can never flip the verdict. Every OTHER class (incl. live-experience) keeps
  // the existing blocker-severity safety net — a non-aesthetic advisory lens
  // emitting a blocker finding STILL fails the panel.
  const blockerFindings = critics.flatMap((c) =>
    c.class === "aesthetic" ? [] : c.findings.filter((f) => f.severity === "blocker"),
  );

  // The floor: >=1 present critic must be class adversarial/reproduction AND
  // blocker===true. An empty/floorless panel is illegal — hard-fail even if
  // every critic present is `ok`. This is the vacuous-panel attack closer.
  const hasFloor = critics.some((c) => (c.class === "adversarial" || c.class === "reproduction") && c.blocker);
  if (!hasFloor) {
    return {
      pass: false,
      blockerFindings,
      reason: "illegal panel: no adversarial/reproduction blocker lens present (§M.3 floor violated)",
    };
  }

  const failingBlockerCritic = critics.find((c) => c.blocker && !c.ok);
  if (failingBlockerCritic) {
    return {
      pass: false,
      blockerFindings,
      reason: `blocker lens "${failingBlockerCritic.lens}" did not clear (ok=false)`,
    };
  }

  // A sized blocker lens that never reported (crash/timeout/no emit_result)
  // must not silently drop out of consideration — treat it as a failure to
  // clear, same as an explicit ok:false.
  if (sized) {
    const missing = sized.filter((l) => l.blocker && !critics.some((c) => c.lens === l.lens));
    if (missing.length > 0) {
      return {
        pass: false,
        blockerFindings,
        reason: `blocker lens(es) never reported a verdict: ${missing.map((l) => l.lens).join(", ")}`,
      };
    }
  }

  if (blockerFindings.length > 0) {
    return {
      pass: false,
      blockerFindings,
      reason: `${blockerFindings.length} blocker-severity finding(s) present`,
    };
  }

  return { pass: true, blockerFindings, reason: "floor present, all blocker lenses cleared, no blocker findings" };
}

// panelReason(): PURE. Surfaces aggregatePanel's human-readable reason string
// for a completed PanelReport (the same strings §M.3 already produces) so the
// executor can carry it onto a verify-summary event and the Verify tab can show
// WHY the panel passed/failed. Empty critics → the classifyPanel "skip" reason.
export function panelReason(report: PanelReport): string {
  if (report.critics.length === 0) return "no critic reported a verdict (nothing judged)";
  return aggregatePanel(report.critics, report.sized).reason;
}

// classifyPanel(): maps a PanelReport to the executor's Verification lattice
// (skip|pass|fail — see executor.ts:classify). Empty critics = nothing
// judged -> "skip", never an auto-promote, mirroring classify()'s own rule.
export function classifyPanel(report: PanelReport): "pass" | "fail" | "skip" {
  if (report.critics.length === 0) return "skip";
  return aggregatePanel(report.critics, report.sized).pass ? "pass" : "fail";
}
