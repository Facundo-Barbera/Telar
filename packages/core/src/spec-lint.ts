// Lints distilled Playwright specs for brittle patterns — CI enforces this so
// distill's output (and any hand-edits to it) stays lint-clean. Line-based and
// regex-driven on purpose: fast, dependency-free, no TS parsing needed.
import fs from "node:fs";
import path from "node:path";

export type LintViolation = { line: number; rule: string; text: string };

// Order matters: violations on the same line are emitted in this order.
const RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "no-locator", pattern: /\.locator\(/ },
  { rule: "no-nth", pattern: /\.nth\(/ },
  { rule: "no-xpath", pattern: /xpath=/ },
  { rule: "no-css-engine", pattern: /css=/ },
  { rule: "no-query-selector", pattern: /\bpage\.\$\$?(?:eval)?\(/ },
  { rule: "no-wait-timeout", pattern: /\.waitForTimeout\(/ },
  { rule: "no-set-timeout", pattern: /(^|[^.\w])setTimeout\(/ },
];

// distill.ts embeds agent-authored criterion text verbatim as test/describe
// titles. That prose can coincidentally contain a banned substring (e.g. a
// criterion describing a bug in terms of "page.locator(...)") even though
// nothing unsafe was emitted. Mask out title string literals before matching
// so only real code is checked — banned strings used as actual selector
// arguments (e.g. `.locator('xpath=//div')`) are unaffected since the banned
// text there sits right next to the executable `.locator(`/`page.$(` call,
// outside any title literal.
const TITLE_LITERAL = /\btest(?:\.skip|\.describe)?\(\s*'(?:\\.|[^'\\])*'/;

function maskTitle(line: string): string {
  return line.replace(TITLE_LITERAL, (m) => {
    const q = m.indexOf("'");
    return m.slice(0, q + 1) + "x".repeat(m.length - q - 2) + "'";
  });
}

export function lintSpec(source: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    const checked = maskTitle(line);
    for (const { rule, pattern } of RULES) {
      if (pattern.test(checked)) violations.push({ line: i + 1, rule, text: line.trim() });
    }
  });
  return violations;
}

export function lintSpecDir(dir: string): { file: string; violations: LintViolation[] }[] {
  const results: { file: string; violations: LintViolation[] }[] = [];
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        const violations = lintSpec(fs.readFileSync(full, "utf8"));
        if (violations.length) results.push({ file: full, violations });
      }
    }
  };
  walk(dir);
  return results;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "e2e";
  const results = lintSpecDir(dir);
  let found = false;
  for (const { file, violations } of results) {
    for (const v of violations) {
      found = true;
      console.log(`${file}:${v.line} ${v.rule}: ${v.text}`);
    }
  }
  process.exit(found ? 1 : 0);
}
