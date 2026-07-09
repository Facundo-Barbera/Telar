// Telar Verifier (QA) agent — docs/verifier-agent.md §3.3/§3.4/§6.1.
// An INDEPENDENT, read-only agent that drives the running app through its
// accessibility tree (Playwright MCP) and judges a feature's acceptance
// criteria on executable evidence. Built on the provider-agnostic agent()
// primitive; it has NO Write/Edit/Bash/Agent — enforced by a hard tools-
// availability restriction (restrictTools, so they're never loaded) plus an
// explicit disallow as defense-in-depth. NOTE: allowedTools alone does NOT gate
// availability under bypassPermissions — see engine.ts restrictTools.
import fs from "node:fs";
import path from "node:path";
import { agent } from "./engine";
import { VerifierReport, type AccountProfile } from "./schemas";

// Read app source to map criteria → UI (never write) + accessibility-first
// browser driving via @playwright/mcp. verify_* tools are omitted: they may not
// exist in @playwright/mcp 0.0.77, so judgment is snapshot-based.
export const VERIFIER_TOOLS: string[] = [
  "Read",
  "Grep",
  "Glob",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_wait_for", // {text|textGone} only — never {time}
  "mcp__playwright__browser_take_screenshot", // evidence only
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_evaluate", // state assertions/extraction, not clicking
  "mcp__playwright__browser_generate_locator", // the distillation bridge
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_handle_dialog",
];

// The system prompt from docs §3.4, verbatim.
export const VERIFIER_SYSTEM_PROMPT = `You are the Telar Verifier: an INDEPENDENT quality agent. You did NOT write this
code and you CANNOT edit it. Your only job is to determine, from EXECUTABLE
EVIDENCE, whether each acceptance criterion of the feature under test is met by
the RUNNING application. Your verdict is trusted precisely because you cannot
change the code to make it pass.

You drive the app through its ACCESSIBILITY TREE, not by guessing selectors and
not by looking at pixels. Your loop is: snapshot -> reason -> act -> re-snapshot.

1. Call browser_navigate to the app URL you were given.
2. Call browser_snapshot to read the ARIA tree. Every interactable node has a
   stable \`ref\`, a role, and an accessible name. Choose targets by ROLE + NAME
   (a "Submit" button, a textbox labeled "Email"), never by position or CSS.
3. Act with browser_click / browser_type / browser_fill_form / browser_select_option
   / browser_press_key, always passing BOTH a human-readable \`element\` description
   AND the \`ref\` from your most recent snapshot. After any action that changes the
   page, take a fresh browser_snapshot before acting again — refs from an old
   snapshot are stale.
4. To wait, use browser_wait_for with \`text\` (appear) or \`textGone\` (disappear).
   NEVER wait for a fixed time. NEVER assume timing. Every action already
   auto-waits for the element to be actionable.

Judge each acceptance criterion explicitly. For EACH criterion:
 - Establish the state that criterion is about (navigate/act as needed).
 - ASSERT it with an assertion tool: browser_verify_text_visible,
   browser_verify_element_visible (role + accessibleName), or browser_verify_value.
   An assertion that passes is your PROOF the criterion holds.
 - Collect evidence: call browser_take_screenshot (name it after the criterion),
   keep the a11y snapshot you just read, and pull browser_console_messages and
   browser_network_requests to catch client errors and confirm the right API
   calls fired with the right status codes.
 - For every ref you interacted with or asserted on, call browser_generate_locator
   and record the returned getByRole/getByLabel string — Telar distills these into
   a regression spec later. This is not optional.

Be RESILIENT, not brittle. If a label moved, a button was renamed, or the DOM
was restructured, ADAPT: re-snapshot and find the semantically-equivalent node by
role and meaning. Only fail a criterion when the app genuinely does not satisfy
it — a functional failure, a thrown console error on the happy path, a wrong
value, a missing element that should exist. Distinguish that from a criterion you
could not evaluate.

Assign each criterion exactly one verdict:
 - "pass": you drove the flow and an assertion proved the criterion holds.
 - "fail": you drove the flow and the app did not satisfy it — cite the exact
   observation (asserted X, saw Y; console error Z; network 500 on /api/…).
 - "flaky": it passed on one attempt and failed on another within this run, or
   depended on timing/order you could not stabilize.
For a "fail", record the minimal repro: the ordered list of role-based steps that
reproduces it.

You have NO Write, Edit, or Bash tools. Do not ask for them. Do not suggest code
fixes as your result — describe the OBSERVED behavior; repair is someone else's
job. Do not claim a criterion passes without an assertion that proves it: an
unproven pass is a "fail" to evaluate.

After judging the functional acceptance criteria, run a DESIGN & UX CRITIQUE
pass. This is SEPARATE from pass/fail: a feature can meet every functional
criterion and still have design findings; likewise a design nit never flips a
functional verdict. Assess: visual consistency (typography/color/component
usage), spacing & alignment, visual hierarchy & emphasis, responsive behavior
(resize the viewport and re-snapshot/screenshot to check reflow), color
contrast & accessible roles/labels, interaction affordances (is the clickable
thing obviously clickable, focus states), and empty/error/loading states. Use
SCREENSHOTS as a judged signal, not just evidence — take a screenshot for each
finding and reference it. If design guidelines are provided below, judge
against them and cite the specific guideline the finding violates. If none are
provided, apply general product-design heuristics. Record each issue in
designFindings[] with { severity (blocker|major|minor|nit), category, title, a
concise detail explaining what and why it matters, an optional recommendation,
and evidence screenshots }. Be concrete and specific — no vague "could be
improved". If the design is genuinely clean, return an empty designFindings[].

When every criterion has a verdict and its evidence, call emit_result exactly
once with the complete VerifierReport. Emitting is the ONLY way your work counts;
if you never emit, Telar records the verification as failed.`;

// Portable resolution of the @playwright/mcp CLI. Precedence: explicit opt ->
// env -> walk up from this module to the workspace and find the installed
// cli.js (chmod +x, node shebang -> spawnable directly). Falls back to the bare
// command name (PATH lookup) so there is NO machine-specific path in source.
export function resolvePlaywrightMcpBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TELAR_PLAYWRIGHT_MCP_BIN) return process.env.TELAR_PLAYWRIGHT_MCP_BIN;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    const candidates = [
      path.join(dir, "apps/web/node_modules/@playwright/mcp/cli.js"),
      path.join(dir, "node_modules/@playwright/mcp/cli.js"),
      path.join(dir, "node_modules/.bin/playwright-mcp"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    // bun's hoisted store: node_modules/.bun/@playwright+mcp@<ver>/node_modules/@playwright/mcp/cli.js
    const store = path.join(dir, "node_modules", ".bun");
    try {
      const hit = fs.readdirSync(store).find((n) => n.startsWith("@playwright+mcp@"));
      if (hit) {
        const cli = path.join(store, hit, "node_modules/@playwright/mcp/cli.js");
        if (fs.existsSync(cli)) return cli;
      }
    } catch {
      /* no store at this level */
    }
  }
  return "playwright-mcp"; // last resort: PATH lookup — never a machine-specific path
}

export type VerifyFeature = { name: string; acceptanceCriteria: string[] };

export type VerifyOpts = {
  url: string;
  evidenceDir: string;
  playwrightBin?: string;
  storageState?: string;
  headless?: boolean;
  account?: AccountProfile;
  model?: string;
  abort?: AbortController;
  designGuidelines?: string;
};

export async function verify(
  feature: VerifyFeature,
  opts: VerifyOpts,
): Promise<VerifierReport | null> {
  // Ensure the evidence dir exists (screenshots land here — see M0 lesson).
  fs.mkdirSync(opts.evidenceDir, { recursive: true });

  const criteriaBlock = feature.acceptanceCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  const task = `${VERIFIER_SYSTEM_PROMPT}

--- Feature under test ---
Feature: ${feature.name}
URL: ${opts.url}
Acceptance criteria:
${criteriaBlock}
${
  opts.designGuidelines
    ? `\n--- Design guidelines (judge design findings against these) ---\n${opts.designGuidelines}`
    : ""
}
Save EVERY screenshot with an ABSOLUTE path under ${opts.evidenceDir} (e.g. ${opts.evidenceDir}/<slug>.png) and record that path in the matching evidence[].path.`;

  const playwrightBin = resolvePlaywrightMcpBin(opts.playwrightBin);

  const args = [
    ...(opts.headless === false ? [] : ["--headless"]),
    "--isolated",
    ...(opts.storageState ? ["--storage-state", opts.storageState] : []),
  ];

  return agent(task, {
    schema: VerifierReport,
    tools: VERIFIER_TOOLS,
    restrictTools: true, // hard wall: only VERIFIER_TOOLS' built-ins load (no Agent/Write/…)
    // Defense-in-depth denylist (redundant with restrictTools, kept for clarity
    // + forward-compat as new write/spawn tools land). "Agent" blocks subagent
    // escalation; "MultiEdit" guards a future rename of the edit tool.
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"],
    settingSources: [],
    cwd: opts.evidenceDir, // belt-and-suspenders: MCP screenshot CWD (M0 lesson)
    model: opts.model,
    account: opts.account,
    abort: opts.abort,
    maxTurns: 40,
    extraMcpServers: {
      playwright: {
        type: "stdio",
        command: playwrightBin,
        args,
        alwaysLoad: true,
        timeout: 90000,
      },
    },
  });
}
