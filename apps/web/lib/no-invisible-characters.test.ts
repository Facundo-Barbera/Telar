// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NO INVISIBLE CHARACTERS IN SOURCE.
 *
 * THIS EXISTS BECAUSE IT HAPPENED TWICE IN ONE DAY. An editing pass wrote a
 * literal NUL byte into a comment in an engine store, and a second one wrote a
 * NUL into a React key — where it sat inside a string literal, rendered as part
 * of the key, and passed `tsc`, `eslint` and 400 tests without a murmur.
 *
 * THAT IS THE WHOLE ARGUMENT FOR THIS FILE. A control character inside a string
 * is legal TypeScript, legal JSX and legal JavaScript. Every gate this repo has
 * is blind to it, the diff shows nothing, and the failure it eventually causes
 * (a key that does not match, a comparison that does not, a grep that never
 * finds the line) is nowhere near the character that caused it.
 *
 * WHAT IS ALLOWED, DELIBERATELY: tab, newline and carriage return, because those
 * are whitespace a formatter owns. Everything else in the C0 range, plus the
 * non-breaking space and the zero-width family and the BOM, is a character
 * somebody could not have typed on purpose in this codebase.
 */
const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** Named so a failure message says WHAT was found, not just a code point. */
const FORBIDDEN = new Map<number, string>([
  [0x00, "NUL"],
  [0x0b, "VERTICAL TAB"],
  [0x0c, "FORM FEED"],
  [0x1b, "ESCAPE"],
  [0x7f, "DELETE"],
  [0xa0, "NO-BREAK SPACE"],
  [0x200b, "ZERO WIDTH SPACE"],
  [0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, "ZERO WIDTH JOINER"],
  [0x2028, "LINE SEPARATOR"],
  [0x2029, "PARAGRAPH SEPARATOR"],
  [0xfeff, "BYTE ORDER MARK"],
]);

/** The trees this repo actually authors. `web_old` and `packages/core` are the
 *  frozen donor and are not ours to police; `node_modules` is nobody's. */
const TREES = [
  "apps/engine/src",
  "apps/engine/test",
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "packages/engine-client/src",
];

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * FILES THAT USE A CONTROL CHARACTER ON PURPOSE, with the reason.
 *
 * A SEPARATOR HAS TO BE A CHARACTER THE DATA CANNOT CONTAIN, so these are
 * correct rather than tolerated: git's own `--format` field/record separators,
 * and two cache keys joining values that may themselves hold any printable
 * character. Removing them would introduce a real bug.
 *
 * ALLOWLISTED BY FILE, NOT BY LINE, because line numbers move and a guard that
 * goes red on an unrelated edit gets deleted. The cost is honest and worth
 * stating: a NEW accidental control character inside one of these five files
 * would not be caught. Everywhere else in the authored tree — which is every
 * file this test was written to protect — it is.
 */
const DELIBERATE = new Set([
  "apps/engine/src/git.ts", // U+001E/U+001F — git --format record and field separators
  "apps/engine/src/github.ts", // U+FEFF — strips a BOM off `gh` output
  "apps/engine/test/github.test.ts", // U+FEFF — the fixture that proves it
  "apps/engine/src/cli-updates.ts", // U+0000 — joins id + binary path into a cache key
  "apps/engine/src/provider-instances.ts", // U+0000 — same, for an instance key
  "apps/web/lib/composer-completions.ts", // U+0000 — tie-breaker key join
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (SOURCE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("source carries no invisible characters", () => {
  test("every authored source file is free of control and zero-width characters", () => {
    const found: string[] = [];
    for (const tree of TREES) {
      for (const file of walk(path.join(ROOT, tree))) {
        if (DELIBERATE.has(path.relative(ROOT, file))) continue;
        const source = fs.readFileSync(file, "utf8");
        for (let i = 0; i < source.length; i++) {
          const code = source.charCodeAt(i);
          const name = FORBIDDEN.get(code);
          // The C0 range wholesale, minus the three a formatter owns.
          const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
          if (!name && !control) continue;
          const line = source.slice(0, i).split("\n").length;
          found.push(
            `${path.relative(ROOT, file)}:${line} — U+${code.toString(16).toUpperCase().padStart(4, "0")} ${name ?? "control character"}`,
          );
        }
      }
    }
    // The whole list, not the first: a corrupting pass tends to write several.
    expect(found).toEqual([]);
  });

  test("this test can actually see one", () => {
    // A scanner that silently matches nothing is the failure mode a guard like
    // this dies of. The needle is BUILT rather than typed, so writing this test
    // cannot itself put a NUL in the tree.
    const needle = `const key = "a${String.fromCharCode(0)}b";`;
    const offenders = [...needle].filter((ch) => FORBIDDEN.has(ch.charCodeAt(0)));
    expect(offenders).toHaveLength(1);
    expect(FORBIDDEN.get(offenders[0]!.charCodeAt(0))).toBe("NUL");
  });
});
