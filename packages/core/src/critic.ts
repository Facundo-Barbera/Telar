// Telar Critic Panel — the intelligent leaves (docs/loom-model.md §3, §4 Layer
// 2, §M.5). Same read-only, Playwright-driven agent shape as verifier.ts, but
// REFRAMED: not "does it check the boxes" but "what did the user actually
// want, and where would this disappoint them?" Each lens is one independent
// agent() call, judged only against the Spec Bundle + the running app.
//
// §M.5 INFORMATION ISOLATION (CRITICAL): a critic must see ONLY the bundle +
// the app url + its own lens charge — never the builder's Verdict/summary,
// never another lens's in-flight verdict. That is enforced here structurally,
// not by convention: `CriticContext` (below) has no field for a builder
// verdict or a sibling verdict, so there is nothing for a caller to leak in
// even by mistake — it is not a parameter that exists.
import fs from "node:fs";
import type {
  AccountProfile,
  ContractAssertion,
  CriticClass,
  CriticVerdict as CriticVerdictType,
  PanelReport as PanelReportType,
} from "./schemas";
import { CriticVerdict, PanelReport } from "./schemas";
import type { LensSpec, PanelSignals } from "./panel";
import { panelSize } from "./panel";
import { agent, type EngineEvent } from "./engine";
import { refreshProjectMcpAuth, resolveProjectMcpServers } from "./mcp";
import { VERIFIER_TOOLS, resolvePlaywrightMcpBin } from "./verifier";

// The Spec Bundle slice + running app a critic is grounded in. Deliberately
// minimal — see the §M.5 note above. Do NOT add a verdict/summary field here.
export type CriticContext = {
  featureName: string;
  url: string;
  objective: string;
  assertions: ContractAssertion[];
};

// Shared framing (§3/§4), verbatim across every lens.
const CRITIC_FRAMING = `You are a Telar Critic: an INDEPENDENT adversarial agent. You did NOT build
this and you CANNOT edit it. Your question is not "does it check the boxes"
but: WHAT DID THE USER ACTUALLY WANT HERE, and WHERE WOULD THIS DISAPPOINT
THEM? Ground every judgment in the Spec Bundle below — never in assumptions
about the implementation.

You drive the RUNNING app live through its ACCESSIBILITY TREE, not by
guessing selectors and not by looking at pixels. Your loop is: snapshot ->
reason -> act -> re-snapshot.

1. Call browser_navigate to the app URL you were given.
2. Call browser_snapshot to read the ARIA tree. Every interactable node has a
   stable \`ref\`, a role, and an accessible name. Choose targets by ROLE + NAME,
   never by position or CSS.
3. Act with browser_click / browser_type / browser_fill_form / browser_select_option
   / browser_press_key, always passing BOTH a human-readable \`element\`
   description AND the \`ref\` from your most recent snapshot. After any action
   that changes the page, take a fresh browser_snapshot before acting again.
4. To wait, use browser_wait_for with \`text\`/\`textGone\`. NEVER wait for a fixed
   time.
5. Collect evidence for anything you cite: browser_take_screenshot (name it
   after the finding), browser_console_messages, browser_network_requests.

You have NO Write, Edit, or Bash tools. Do not suggest code fixes — describe
the OBSERVED behavior; repair is someone else's job.

Record each problem you find in findings[] with { severity (blocker|major|
minor|nit), title, detail explaining what and why it matters to the user, an
optional recommendation, evidence screenshots, and assertionId when it ties to
a specific Verification Contract assertion }. A "blocker" finding means: this
would genuinely fail the user, not a nitpick.

Set ok=true only if, against your lens's charge below, this feature is
genuinely acceptable to ship. When you are done, call emit_result exactly once
with your complete verdict. Emitting is the ONLY way your judgment counts.`;

// Per-lens charge (§4 Layer 2 bullets). Domain lenses (security/performance/
// data-integrity) are only ever sized in by panelSize() when the work calls
// for it.
const LENS_CHARGE: Record<CriticClass, string> = {
  intent: `Charge: INTENT / ACCEPTANCE. Does this satisfy the Verification
Contract AND the spirit behind it? Walk every assertion below as a real
scenario, not a checkbox — if it technically passes but misses what the user
was actually asking for, that is a finding.`,
  adversarial: `Charge: ADVERSARIAL / EDGE. You are trying to break this. Feed
it nasty inputs (empty, huge, malformed, boundary, rapid-repeat), find the
unhandled path, and report exactly what breaks it and how.`,
  reproduction: `Charge: REPRODUCTION. Drive the app COLD, from scratch, with
no assumptions carried over from anyone else's run. Does the claimed behavior
actually reproduce, right now, exactly as the Spec Bundle describes it? A
claim that only "sort of" reproduces is a finding.`,
  "live-experience": `Charge: LIVE EXPERIENCE (UX/design). Experience this as
a real user would, start to finish. Is it actually good — clear, responsive,
free of dead ends and confusing states — not merely functional?`,
  security: `Charge: SECURITY. Probe for the domain failure modes that matter
here: injection, auth/authz gaps, data exposure, unsafe defaults. Report what
you could get away with.`,
  performance: `Charge: PERFORMANCE. Judge responsiveness and cost under
realistic load/data volume implied by the Spec Bundle — sluggish interactions,
N+1-shaped network chatter, unbounded payloads.`,
  "data-integrity": `Charge: DATA INTEGRITY. Verify state stays correct across
the flow — no silent data loss, no double-writes, no drift between what the UI
shows and what the network/console evidence proves actually happened.`,
};

// criticPrompt(): builds the ENTIRE task text a critic agent sees. Only ever
// reads `lens` and `ctx` (both minimal, see CriticContext above) — there is
// structurally nothing else this function could fold in.
export function criticPrompt(lens: LensSpec, ctx: CriticContext): string {
  const assertionsBlock = ctx.assertions.length
    ? ctx.assertions
        .map((a, i) => {
          const bits = [`type: ${a.type}`];
          if (a.expected) bits.push(`expected: ${a.expected}`);
          if (a.expectedFile) bits.push(`expected file: ${a.expectedFile}`);
          if (a.observable) bits.push(`observable: ${a.observable}`);
          return `${i + 1}. [${a.id}] ${a.description} (${bits.join(", ")})`;
        })
        .join("\n")
    : "(no assertions declared)";

  return `${CRITIC_FRAMING}

--- Your lens: ${lens.lens} (${lens.class}${lens.blocker ? ", BLOCKER — must clear" : ", advisory"}) ---
${LENS_CHARGE[lens.class]}

--- Spec Bundle ---
Feature: ${ctx.featureName}
Objective: ${ctx.objective}
URL: ${ctx.url}

Verification Contract assertions (ground every judgment in these):
${assertionsBlock}`;
}

export type CriticRunOpts = {
  evidenceDir: string;
  playwrightBin?: string;
  storageState?: string;
  headless?: boolean;
  account?: AccountProfile;
  model?: string;
  abort?: AbortController;
  maxTurns?: number;
  onEvent?: (e: EngineEvent) => void;
  // The project whose manifest MCP servers to make available (read-only,
  // enforced by the server URL's ?read_only=true). Absent → playwright only.
  project?: string;
  // Injectable agent runner — defaults to the real engine agent() call so
  // tests can supply a mock and never make a live call.
  run?: typeof agent;
};

// runCritic(): one agent() call for one lens, in the verifier's read-only
// Playwright-driven shape (VERIFIER_TOOLS, restrictTools:true, the same
// disallow/settingSources/extraMcpServers pattern). `blocker`/`class` are
// authoritative from the LensSpec the panel sized — never trusted from the
// agent's own self-report, so a critic can't downgrade its own severity.
export async function runCritic(
  lens: LensSpec,
  ctx: CriticContext,
  opts: CriticRunOpts,
): Promise<CriticVerdictType | null> {
  fs.mkdirSync(opts.evidenceDir, { recursive: true });
  const run = opts.run ?? agent;
  const playwrightBin = resolvePlaywrightMcpBin(opts.playwrightBin);
  const args = [
    ...(opts.headless === false ? [] : ["--headless"]),
    "--isolated",
    ...(opts.storageState ? ["--storage-state", opts.storageState] : []),
  ];

  // Refresh any near-expiry Telar-owned MCP OAuth tokens before resolving the
  // project servers so the injected Bearer is live (best-effort; never throws).
  if (opts.project) await refreshProjectMcpAuth(opts.project);

  const result = await run(criticPrompt(lens, ctx), {
    schema: CriticVerdict,
    tools: VERIFIER_TOOLS,
    restrictTools: true,
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"],
    settingSources: [],
    cwd: opts.evidenceDir,
    model: opts.model,
    account: opts.account,
    abort: opts.abort,
    maxTurns: opts.maxTurns ?? 40,
    onEvent: opts.onEvent,
    extraMcpServers: {
      playwright: { type: "stdio", command: playwrightBin, args, alwaysLoad: true, timeout: 90000 },
      // Project MCP servers (same access the builder gets); read-only is
      // enforced by each server URL's ?read_only=true, so nothing extra needed.
      ...(opts.project ? resolveProjectMcpServers(opts.project) : {}),
    },
  });

  if (!result) return null;
  return { ...result, class: lens.class, blocker: lens.blocker };
}

export type PanelEvent =
  | { type: "critic-cost"; lens: string; costUsd: number }
  | { type: "critic-verdict"; lens: string; verdict: CriticVerdictType | null; durationMs?: number; turns?: number }
  // M1 (D2): additive verifier-process events surfacing the panel's live work.
  // `panel-sized` fires once before any lens runs; the per-lens `critic-start`/
  // `critic-step`/`critic-observation`/`critic-text` stream each critic's
  // tool-by-tool loop. None carry control-flow weight — they are opportunistic
  // inspection signals only.
  | { type: "panel-sized"; sized: LensSpec[]; sizedFrom: Record<string, number> }
  | { type: "critic-start"; lens: string; class: CriticClass; blocker: boolean }
  | { type: "critic-step"; lens: string; name: string; input?: string }
  | { type: "critic-observation"; lens: string; kind: string; output?: string }
  | { type: "critic-text"; lens: string; text: string };

// Omit + redeclare `onEvent`, not a plain `&`: CriticRunOpts.onEvent is typed
// (e: EngineEvent) => void, and a bare intersection would force callers into
// an unsatisfiable `((e: EngineEvent) => void) & ((e: PanelEvent) => void)`.
// runPanel only ever invokes opts.onEvent with PanelEvent (it builds its own
// EngineEvent-typed onEvent for the inner runCritic call, below) — this is a
// type-only correction, no runtime change.
export type RunPanelOpts = Omit<CriticRunOpts, "onEvent"> & {
  signals: PanelSignals;
  maxCriticAgents?: number; // the reserved sub-pool (§M budget.maxCriticAgents), default 3
  retryBlockerOnly?: boolean; // retry-awareness: re-run only blocker lenses + a fresh reproduction lens
  onEvent?: (e: PanelEvent) => void;
};

// Stringify an engine tool `input` (already size-capped by the engine's
// capToolInput) for a critic-step event field — strings pass through, anything
// else is JSON-serialized best-effort. Never throws.
function capEventText(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// A retry re-runs only the lenses that must clear, plus a fresh reproduction
// pass (never reused from a prior run — "fresh" means driven cold again).
function retryLenses(lenses: LensSpec[]): LensSpec[] {
  const blockers = lenses.filter((l) => l.blocker);
  const fresh: LensSpec = { class: "reproduction", lens: "reproduction/cold-retry", blocker: true };
  return blockers.some((l) => l.lens === fresh.lens) ? blockers : [...blockers, fresh];
}

// runPanel(): sizes the panel via panelSize(signals), runs each lens through
// runCritic with concurrency bounded by opts.maxCriticAgents, and assembles a
// PanelReport carrying sizedFrom (the raw signals) for audit. Emits a
// PanelEvent per critic so panel cost/verdicts can flow into the caller's
// spentUsd/UI — this module never touches spentUsd itself (deterministic
// control flow stays in the caller, per the loom model's design law).
export async function runPanel(ctx: CriticContext, opts: RunPanelOpts): Promise<PanelReportType> {
  const maxCriticAgents = opts.maxCriticAgents ?? 3;
  const sized = panelSize(opts.signals);
  const lenses = opts.retryBlockerOnly ? retryLenses(sized) : sized;

  const sizedFrom: Record<string, number> = {
    diffLines: opts.signals.diffLines,
    filesTouched: opts.signals.filesTouched,
    filesOutsideAllowed: opts.signals.filesOutsideAllowed,
    protectedPathsTouched: opts.signals.protectedPathsTouched ? 1 : 0,
    priorFailingCritics: opts.signals.priorFailingCritics,
  };
  // M1 (D2): announce the sized panel BEFORE any lens runs so the Verify tab can
  // show which lenses are pending and why (the sizedFrom audit trail).
  opts.onEvent?.({ type: "panel-sized", sized: lenses, sizedFrom });

  const verdicts: (CriticVerdictType | null)[] = new Array(lenses.length).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= lenses.length) return;
      const lens = lenses[i]!;
      // M1 (D2): mark this lens started so a crashed/never-emitting blocker is
      // visible in the timeline (aggregatePanel's `sized` still fails it).
      opts.onEvent?.({ type: "critic-start", lens: lens.lens, class: lens.class, blocker: lens.blocker });
      let durationMs: number | undefined;
      let turns: number | undefined;
      const verdict = await runCritic(lens, ctx, {
        evidenceDir: opts.evidenceDir,
        playwrightBin: opts.playwrightBin,
        storageState: opts.storageState,
        headless: opts.headless,
        account: opts.account,
        model: opts.model,
        abort: opts.abort,
        maxTurns: opts.maxTurns,
        project: opts.project,
        run: opts.run,
        onEvent: (e) => {
          // M1 (D2): forward the critic's live tool-by-tool loop (no longer drop
          // everything but `result`). `lens` scopes each step to its critic.
          if (e.type === "result") {
            if (e.costUsd != null) opts.onEvent?.({ type: "critic-cost", lens: lens.lens, costUsd: e.costUsd });
            durationMs = undefined; // durationMs isn't on the engine result; turns is
            turns = e.turns;
          } else if (e.type === "text") {
            opts.onEvent?.({ type: "critic-text", lens: lens.lens, text: e.text });
          } else if (e.type === "tool") {
            opts.onEvent?.({ type: "critic-step", lens: lens.lens, name: e.name, input: capEventText(e.input) });
          } else if (e.type === "tool-result") {
            opts.onEvent?.({ type: "critic-observation", lens: lens.lens, kind: e.name ?? "result", output: e.output });
          }
        },
      });
      verdicts[i] = verdict;
      opts.onEvent?.({ type: "critic-verdict", lens: lens.lens, verdict, durationMs, turns });
    }
  }

  const poolSize = Math.max(1, Math.min(maxCriticAgents, lenses.length || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return PanelReport.parse({
    url: ctx.url,
    critics: verdicts.filter((v): v is CriticVerdictType => v !== null),
    sizedFrom,
    sized: lenses,
  });
}
