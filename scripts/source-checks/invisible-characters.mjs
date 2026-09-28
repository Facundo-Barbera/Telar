import { filesUnder, read } from "./files.mjs";

// A control character inside a string is legal TypeScript and passes every other gate; the bug it causes surfaces far away.
const FORBIDDEN = new Map([
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

const TREES = ["apps/engine/src", "apps/engine/test", "apps/web/src", "apps/desktop/src", "packages/engine-client/src", "scripts"];

// Separators that must be characters the data cannot contain. Allowlisted by file, since line numbers move.
const DELIBERATE = new Set([
  "apps/engine/src/platform/git/parse.ts",
  "apps/engine/src/domains/github/detail.ts",
  "apps/engine/src/domains/github/detail.test.ts",
  "apps/web/src/features/composer/completions.ts",
]);

/** `file:line — U+XXXX NAME` for every forbidden character in `source`. */
export function invisibleCharacters(source, file) {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const name = FORBIDDEN.get(code);
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (!name && !control) continue;
    const line = source.slice(0, i).split("\n").length;
    found.push(`${file}:${line} — U+${code.toString(16).toUpperCase().padStart(4, "0")} ${name ?? "control character"}`);
  }
  return found;
}

export const invisibleCharactersCheck = {
  name: "no-invisible-characters",
  protects: "authored source carries no control, zero-width or no-break characters outside the allowlisted separators",
  run() {
    const files = TREES.flatMap((tree) => filesUnder(tree, /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, { tests: true }));
    return files.filter((file) => !DELIBERATE.has(file)).flatMap((file) => invisibleCharacters(read(file), file));
  },
};
