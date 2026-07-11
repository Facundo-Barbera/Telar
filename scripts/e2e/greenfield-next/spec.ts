import {
  Charter as CharterSchema,
  type Charter,
  type ProjectManifest,
  type VerificationContract,
} from "@telar/core";

export const APP_HEADING = "Telar E2E Greenfield";
export const APP_SUBTITLE = "A minimal Next.js app scaffolded and verified by Telar.";

export const OBJECTIVE_MD = `# Minimal Next.js (Bun) app — greenfield

Starting from an EMPTY project directory, scaffold and run a minimal Next.js
application using the App Router, managed with Bun. The finished app must:

- install its dependencies with \`bun install\` and compile cleanly with \`bun run build\`
- expose an App Router root layout and a single home page
- render a minimal home page with a visible top-level heading reading
  "${APP_HEADING}" and, beneath it, a short subtitle paragraph reading
  "${APP_SUBTITLE}"

Use only Bun (never npm/yarn/pnpm). Add no dependency beyond next, react, and
react-dom. No database, auth, or test framework. Keep the app as small as
possible while satisfying the Verification Contract.`;

export const ROADMAP_MD = `# Build order

- s1 (scaffold) — create package.json, app/layout.tsx, app/page.tsx, tsconfig.json;
  \`bun install\`; \`bun run build\` must pass.
- s2 (ui) — dependsOn s1. Render the required heading + subtitle on the home page.

Threads run serially (s2 dependsOn s1) in the same project directory.`;

export const S1_DETAIL = `Scaffold a minimal Next.js App Router project managed with Bun, in the project
root (currently an EMPTY directory). Create EXACTLY these files:

- package.json:
  { "private": true,
    "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
    "dependencies": { "next": "^15", "react": "^19", "react-dom": "^19" } }
- app/layout.tsx: a root layout with a default export returning
  <html lang="en"><body>{children}</body></html>  (props typed { children: React.ReactNode }).
- app/page.tsx: a server component default export returning
  <main><h1>${APP_HEADING}</h1></main>.
- tsconfig.json: a minimal Next-compatible TypeScript config.

Then run \`bun install\` and confirm \`bun run build\` exits 0. Do NOT create a
src/ directory, a pages/ directory, or any extra files. Use Bun only.`;

export const S2_DETAIL = `The project already has a minimal Next.js App Router scaffold that builds.
Enhance ONLY app/page.tsx so the home page renders a minimal but complete UI:
a top-level <h1> with the EXACT text "${APP_HEADING}" and, directly beneath it,
a <p> subtitle with the EXACT text "${APP_SUBTITLE}". Keep it a single server
component; minimal inline styling is fine. Add no dependencies and no new files.
Confirm \`bun run build\` still exits 0 and the page renders with no error overlay.`;

// --- Verification Contract -------------------------------------------------
// Partitioned across TWO subGoalIds (s1, s2) so the injected weave has two
// threads; the ALL slice is deterministic-only so the root integration verify
// is a zero-browser pass and never demotes the woven "ready".
export function buildContract(): VerificationContract {
  return {
    version: 1,
    assertions: [
      {
        id: "a_build",
        subGoalId: "ALL",
        description: "The Next.js app compiles: `bun run build` exits 0.",
        type: "gate",           // -> manifest.gates[name==="build"].run === "bun run build"
        expected: "build",
        blocker: true,
      },
      {
        id: "a_s1_files",
        subGoalId: "s1",
        description: "Minimal App Router scaffold exists (package.json, app/layout.tsx, app/page.tsx, tsconfig.json).",
        type: "command",
        expected: "test -f package.json && test -f app/layout.tsx && test -f app/page.tsx && test -f tsconfig.json",
        blocker: true,
      },
      {
        id: "a_s2_ui_source",
        subGoalId: "s2",
        description: "Home page source contains the required heading and subtitle text.",
        type: "command",
        expected: "grep -q 'Telar E2E Greenfield' app/page.tsx && grep -q 'minimal Next.js app' app/page.tsx",
        blocker: true,
      },
      {
        id: "a_s2_ui_live",
        subGoalId: "s2",
        description: "The rendered home page shows the app heading and subtitle.",
        type: "live-critic",
        observable:
          "Loading the home page in a browser shows a visible top-level heading reading '" +
          APP_HEADING + "' and, beneath it, a short subtitle paragraph; the page renders with no Next.js error overlay.",
        blocker: true,
      },
    ],
  };
}

// --- Injected woven Charter (guarantees invariant #1: orchestration) -------
export function buildWovenCharter(): Charter {
  return CharterSchema.parse({
    objective: "Scaffold and verify a minimal Next.js (Bun) App Router app from an empty directory.",
    proofStrategy: "custom",
    scope: { allowedPaths: [], forbiddenPaths: [], notes: "Single project dir; threads run serially." },
    budget: { maxParallelThreads: 1, maxAgents: 4, maxCriticAgents: 2 },
    decomposition: [
      { id: "s1", title: "Scaffold minimal Next.js (Bun) app", detail: S1_DETAIL,
        proofStrategy: "custom", acceptanceCriteria: [], dependsOn: [], required: true },
      { id: "s2", title: "Minimal home-page UI", detail: S2_DETAIL,
        proofStrategy: "custom", acceptanceCriteria: [], dependsOn: ["s1"], required: true },
    ],
    version: 1,
  });
}

// --- Project manifest written to telar.yaml --------------------------------
export function buildManifest(projectName: string, projectRoot: string): Partial<ProjectManifest> {
  return {
    name: projectName,
    root: projectRoot,
    adapter: "plain",              // no "next" adapter exists
    account: process.env.TELAR_E2E_ACCOUNT ?? "personal", // auto-seeded on a fresh TELAR_HOME
    charterPolicy: "auto",         // never pause for charter review
    baseBranch: "main",            // cosmetic; read by no core logic
    gates: [{ name: "build", run: "bun run build" }], // referenced by the a_build gate assertion
    guardrails: { disallowedTools: [], protectedPaths: [] },
    devCommand: "bun run dev",     // REQUIRED — makes the panel auto-spin a dev server
    // DELIBERATELY NO `urls`/`urls.dev` — absence is what triggers the auto-spin (executor.ts:486)
  };
}
