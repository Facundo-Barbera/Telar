// Distill: turn a VerifierReport into a durable Playwright regression spec.
// Pure/deterministic — no fs, no Date, no randomness — so the same report
// always produces byte-identical output. Node built-ins only (see file header
// in the M3 brief): this module must not import @playwright/test, it only
// emits source text that references it.
import type { CriterionResult, ReproStep, VerifierReport } from "./schemas";

export type DistillFeature = { name: string; role?: string; tags?: string[] };

// Escape a value for embedding in a single-quoted JS string literal.
function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]+/g, " ");
}

// Derive an origin-agnostic relative path from a URL (or an already-relative
// path). Falls back to '/' when nothing usable can be parsed.
function toRelPath(raw: string): string {
  try {
    const u = new URL(raw);
    return u.pathname + u.search || "/";
  } catch {
    return raw.startsWith("/") ? raw : "/";
  }
}

// A JS single-quoted string literal — escape sequences allowed, no bare
// quote/backslash/newline inside. This is exactly what q() below always
// produces, so it's what we require back on the trust boundary too: a
// stored locator's own quoted args (e.g. a name coming from real UI copy
// like "OBrien's page") must already be validly escaped, or we refuse to
// splice them into the emitted spec verbatim.
const STRING_LIT = String.raw`'(?:\\.|[^'\\\r\n])*'`;
const LOCATOR_ARG = `(?:${STRING_LIT}|true|false|-?\\d+(?:\\.\\d+)?)`;
const LOCATOR_OBJ_PROP = `\\s*\\w+:\\s*${LOCATOR_ARG}\\s*`;
const LOCATOR_OBJ = `\\{(?:${LOCATOR_OBJ_PROP}(?:,${LOCATOR_OBJ_PROP})*)?\\}`;
const LOCATOR_ARGS = `(?:${LOCATOR_ARG}|${LOCATOR_OBJ})(?:,\\s*(?:${LOCATOR_ARG}|${LOCATOR_OBJ}))*`;

// Full-match, not just prefix: a single getBy*(...) call, and nothing else,
// whose every argument is a syntactically valid already-escaped JS literal.
// This rejects both chained suffixes like `.locator('.foo')` tacked onto an
// otherwise-safe call, and a call whose own string argument contains an
// unescaped quote — either of which would otherwise splice broken/unsafe
// source straight into the emitted spec.
const SAFE_LOCATOR = new RegExp(
  `^(page\\.)?(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|getByAltText|getByTitle)\\((${LOCATOR_ARGS})?\\)$`,
);

// A stored locator is only trusted when it's already a role/label/text-style
// Playwright locator — anything else (raw CSS, xpath, `.locator(...)`) is
// discarded so the emitted spec can never contain a brittle selector.
function safeLocator(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!SAFE_LOCATOR.test(trimmed)) return null;
  return trimmed.startsWith("page.") ? trimmed : `page.${trimmed}`;
}

// Best-effort re-derivation of a getBy* locator from a human-readable target
// description, e.g. "button 'Submit'" or "textbox labeled 'Email'".
function locatorFromTarget(target: string): string {
  const role = target.match(/^(\w+)\s+'([^']*)'$/);
  if (role) return `page.getByRole('${q(role[1])}', { name: '${q(role[2])}' })`;
  const labeled = target.match(/labeled\s+'([^']*)'/);
  if (labeled) return `page.getByLabel('${q(labeled[1])}')`;
  return `page.getByText('${q(target)}')`;
}

function resolveLocator(target: string, stored?: string): string {
  return safeLocator(stored) ?? locatorFromTarget(target);
}

function reproStepLines(step: ReproStep): string[] {
  switch (step.action) {
    case "navigate":
      return [`    await page.goto('${q(toRelPath(step.value || step.target))}');`];
    case "click":
      return [`    await ${resolveLocator(step.target, step.locator)}.click();`];
    case "fill":
    case "type":
      return [`    await ${resolveLocator(step.target, step.locator)}.fill('${q(step.value ?? "")}');`];
    case "select":
      return [`    await ${resolveLocator(step.target, step.locator)}.selectOption('${q(step.value ?? "")}');`];
    case "press":
      return [`    await ${resolveLocator(step.target, step.locator)}.press('${q(step.value ?? "")}');`];
    case "assert": {
      const loc = resolveLocator(step.target, step.locator);
      return step.value !== undefined
        ? [`    await expect(${loc}).toHaveValue('${q(step.value)}');`]
        : [`    await expect(${loc}).toBeVisible();`];
    }
    default:
      return [`    // unrecognized repro action '${q(step.action)}' — skipped`];
  }
}

function testBlock(c: CriterionResult, basePath: string, tagsLiteral: string): string[] {
  const title = q(c.criterion);
  const hasRepro = c.repro.length > 0;
  const hasLocators = c.locators.length > 0;

  if (!hasRepro && !hasLocators) {
    return [
      `  test.skip('${title}', { tag: ${tagsLiteral} }, async ({ page }) => {`,
      `    // no steps or role-locators recorded — re-derive via exploration`,
      `  });`,
      "",
    ];
  }

  const body: string[] = [];
  if (hasRepro) {
    for (const step of c.repro) body.push(...reproStepLines(step));
  } else {
    body.push(`    await page.goto('${q(basePath)}');`);
    for (const raw of c.locators) {
      const loc = safeLocator(raw);
      if (!loc) continue; // discard unsafe raw selectors — never emitted
      body.push(`    await expect(${loc}).toBeVisible();`);
    }
  }

  return [`  test('${title}', { tag: ${tagsLiteral} }, async ({ page }) => {`, ...body, `  });`, ""];
}

export function distillSpec(feature: DistillFeature, report: VerifierReport): string {
  const basePath = toRelPath(report.url);
  const tags = feature.tags ?? ["@smoke"];
  const tagsLiteral = `[${tags.map((t) => `'${q(t)}'`).join(", ")}]`;

  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test.describe('${q(feature.name)}', () => {`,
  ];

  for (const c of report.criteria) {
    if (c.verdict !== "pass") continue;
    lines.push(...testBlock(c, basePath, tagsLiteral));
  }

  lines.push("});", "");
  return lines.join("\n");
}

export function playwrightConfigTemplate(opts?: { storageStateSetup?: boolean }): string {
  const projects = opts?.storageStateSetup
    ? `  projects: [
    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.telar/storageState.json' },
      dependencies: ['setup'],
    },
  ],`
    : `  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],`;

  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 2,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:3131',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
${projects}
});
`;
}
