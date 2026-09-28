import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROOT } from "./source-invariants-files.mjs";

/**
 * EVERY SHELL SCRIPT IN THE TREE, repo-relative. Same exclusions as
 * `testFilesUnder` and for the same reason: `release/` and `.next-desktop/`
 * hold copies of source nobody can fix in place.
 */
export async function shellFiles() {
  const found = [];
  const walk = async (from) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, from), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = from ? `${from}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "release" || entry.name === ".git") continue;
        if (entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (entry.name.endsWith(".sh")) {
        found.push(next);
      }
    }
  };
  await walk("");
  return found.sort();
}

/** Does this script opt into `set -u`, where an empty array becomes fatal? */
export const enablesNounset = (source) => /^\s*set\s+(-[a-zA-Z]*u|-o\s+nounset)/m.test(source);

// Under `set -u`, macOS bash 3.2 treats `"${A[@]}"` on an empty array as unbound. Guarded forms
// (`${#A[@]}`, `${A[@]+"${A[@]}"}`, `${A[*]-}`) are skipped whole, since the guard repeats the bare expansion.
export function unguardedArrayExpansions(source) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return; // a comment, including this file's own prose
    for (let i = 0; i < line.length; i += 1) {
      if (!line.startsWith("${", i)) continue;
      const opened = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]/.exec(line.slice(i));
      if (!opened) continue;
      const after = line[i + opened[0].length];
      if (after === "}") {
        hits.push({ line: index + 1, name: opened[1], text: line.trim() });
        continue;
      }
      // Guarded: jump past the whole `${A[@]+…}` so the copy nested in it is
      // not read as a bare expansion of its own.
      let depth = 0;
      let end = i;
      for (let j = i; j < line.length; j += 1) {
        if (line.startsWith("${", j)) {
          depth += 1;
          j += 1;
          continue;
        }
        if (line[j] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      i = end;
    }
  });
  return hits;
}

const WORKFLOWS = ".github/workflows";

/** Every workflow definition, repo-relative. */
export async function workflowFiles() {
  let entries;
  try {
    entries = await readdir(join(ROOT, WORKFLOWS), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => `${WORKFLOWS}/${entry.name}`)
    .sort();
}

const indentOf = (line) => line.length - line.trimStart().length;

// Absent `shell:` means `bash -e {0}`: no nounset unless the block sets it; non-bash blocks are skipped.
const runsBash = (shell) => {
  if (shell === null) return true; // GitHub's default for a `run:` step
  const named = shell.trim().replace(/^["']|["']$/g, "").split(/\s+/)[0];
  return named === "bash" || named === "sh";
};

/** `run:` blocks with their real file line numbers; `shell:` is read only at the exact `run:` indent. */
export function workflowRunBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];

  const shellFor = (at, keyIndent) => {
    const leavesStep = (j) => {
      const raw = lines[j];
      if (raw.trim() === "") return false;
      return indentOf(raw) < keyIndent || raw.trimStart().startsWith("- ");
    };
    const declared = (j) => {
      const found = /^(\s*)shell:\s*(.+?)\s*$/.exec(lines[j]);
      return found && found[1].length === keyIndent ? found[2] : null;
    };
    for (let j = at - 1; j >= 0 && !leavesStep(j); j -= 1) {
      const found = declared(j);
      if (found !== null) return found;
    }
    for (let j = at + 1; j < lines.length && !leavesStep(j); j += 1) {
      const found = declared(j);
      if (found !== null) return found;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const opened = /^(\s*)run:[ \t]*(?:[|>][-+]?\d*)?[ \t]*(.*)$/.exec(lines[i]);
    if (!opened) continue;
    const keyIndent = opened[1].length;
    const body = [];
    if (opened[2].trim() !== "") {
      body.push({ line: i + 1, text: opened[2] });
    } else {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === "") {
          body.push({ line: j + 1, text: "" });
          continue;
        }
        if (indentOf(lines[j]) <= keyIndent) break;
        body.push({ line: j + 1, text: lines[j] });
      }
    }
    blocks.push({ line: i + 1, shell: shellFor(i, keyIndent), body });
  }
  return blocks;
}

/** Unguarded expansions in a `run:` block, or null without nounset, so "looked at nothing" differs from "found nothing". */
export function workflowBlockHits(block) {
  if (!runsBash(block.shell)) return null;
  const text = block.body.map((entry) => entry.text).join("\n");
  if (!enablesNounset(text)) return null;
  return unguardedArrayExpansions(text).map((hit) => ({ ...hit, line: block.body[hit.line - 1].line }));
}

export const ARRAY_GUARD_SAMPLES = [
  { flags: true, why: "the #808 line as it was", code: 'bunx electron-builder --dir "${CONFIG_OVERRIDES[@]}"' },
  { flags: true, why: "a `[*]` in a message string is unbound on 3.2 too", code: 'log "--mac ${TARGET_ARGS[*]}"' },
  { flags: true, why: "an unquoted bare expansion is no safer", code: "for a in ${ARTIFACTS[@]}; do :; done" },
  { flags: false, why: "the portable guard", code: 'bunx electron-builder ${CONFIG_OVERRIDES[@]+"${CONFIG_OVERRIDES[@]}"}' },
  { flags: false, why: "the `-` guard for a string context", code: 'log "--mac ${TARGET_ARGS[*]-}"' },
  { flags: false, why: "a count is never unbound", code: 'if [ "${#ARTIFACTS[@]}" -gt 0 ]; then :; fi' },
  { flags: false, why: "positional parameters are special-cased by bash", code: 'install "$@"' },
  { flags: false, why: "a single element is not the empty-array case", code: 'echo "${ARTIFACTS[0]}"' },
  { flags: false, why: "prose in a comment", code: '# `"${A[@]}"` is what broke; see #808' },
];

// `hits` are `line:NAME` at the sample's line; `scanned` is how many blocks the reader should see.
export const WORKFLOW_BLOCK_SAMPLES = [
  {
    why: "the #829 shape: a `run:` block that opts into -u and then expands a bare array",
    hits: ["7:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"',
    ],
  },
  {
    why: "the same block once guarded",
    hits: [],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          security list-keychains -d user -s "$KEYCHAIN" ${EXISTING[@]+"${EXISTING[@]}"}',
    ],
  },
  {
    why: "GitHub's default shell is `bash -e {0}` — -e, not -u — so a block that never says `set -u` is not this check's business",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      '          security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"',
    ],
  },
  {
    why: "another interpreter has no bash arrays to get wrong",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        shell: pwsh",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
    ],
  },
  {
    why: "`shell:` governs its step from either side of the `run:` it belongs to",
    hits: [],
    scanned: 0,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
      "        shell: python",
    ],
  },
  {
    why: "a body line TALKING about a shell is not the step's shell",
    hits: ["8:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: Import",
      "        run: |",
      "          set -euo pipefail",
      '          echo "shell: pwsh"',
      '          echo "${EXISTING[@]}"',
    ],
  },
  {
    why: "the next step's `shell:` does not reach back over the step boundary",
    hits: ["7:EXISTING"],
    scanned: 1,
    yaml: [
      "jobs:",
      "  sign:",
      "    steps:",
      "      - name: One",
      "        run: |",
      "          set -euo pipefail",
      '          echo "${EXISTING[@]}"',
      "      - name: Two",
      "        shell: pwsh",
      "        run: echo hi",
    ],
  },
  {
    why: "a one-line `run:` is a block too, and is read without crashing on its missing body",
    hits: [],
    scanned: 0,
    yaml: ["jobs:", "  sign:", "    steps:", "      - name: One", "        run: apps/ios/nightly.sh"],
  },
];

/** Every `spawnSync(` / `Bun.spawnSync(` call with its argument text, paren-balanced since calls span lines. */
export function syncSpawnCalls(source) {
  const calls = [];
  const pattern = /(?<![\w$.])(?:Bun\.)?spawnSync\s*\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const args = source.slice(open + 1, end);
    calls.push({
      line: source.slice(0, match.index).split("\n").length,
      call: match[0].slice(0, -1).trim(),
      bounded: /\btimeout\s*:/.test(args),
      forceful: /\bkillSignal\s*:\s*"SIGKILL"/.test(args),
    });
  }
  return calls;
}

// The suite's own call sites, plus options several lines down, nested calls and look-alike names.
export const SYNC_SPAWN_SAMPLES = [
  { flags: true, why: "the bare node call as latex-managed had it", code: `const made = spawnSync("tar", ["-czf", archive]);` },
  { flags: true, why: "the bare Bun call as project-identity had it", code: `Bun.spawnSync(["git", ...args], { cwd: checkout });` },
  { flags: true, why: "a timeout with a polite signal is still a process that may not answer", code: `spawnSync("tar", [], { timeout: 5_000 });` },
  { flags: true, why: "a killSignal with no ceiling never fires at all", code: `spawnSync("tar", [], { killSignal: "SIGKILL" });` },
  { flags: false, why: "the bounded node call", code: `spawnSync("tar", ["-czf", archive], { timeout: 5_000, killSignal: "SIGKILL" });` },
  { flags: false, why: "the bounded Bun call", code: `Bun.spawnSync(["git", ...args], { cwd: checkout, timeout: 5_000, killSignal: "SIGKILL" });` },
  {
    flags: false,
    why: "options several lines below the call, with a nested call in the arguments — the shape a line scan misses",
    code: `const run = spawnSync(process.execPath, ["test", ...(flag ? ["--timeout", flag] : [])], {\n  cwd: REPO_ROOT,\n  timeout: budgetMs,\n  killSignal: "SIGKILL",\n});`,
  },
  { flags: false, why: "a different function that merely ends the same way", code: `mySpawnSync("tar", []);` },
  { flags: false, why: "the async spawn, which no ceiling problem applies to", code: `spawn("tar", ["-czf", archive]);` },
  { flags: false, why: "the import, which is not a call", code: `import { spawnSync } from "node:child_process";` },
];

// The one push to a remote may only append: an argv whose first element is `"push"` carries no
// force or delete token. Bracket-matched because argvs span lines.
const FORBIDDEN_PUSH_TOKENS = [
  { token: "--force", why: "a force push overwrites commits that were already on the remote" },
  { token: "--force-with-lease", why: "a lease is still an overwrite, and this engine has no reader to check the lease for" },
  { token: "--delete", why: "deleting a remote branch is not additive and is not recoverable" },
  { token: "-f", why: "`-f` is `--force` spelled shorter" },
];

/** Every git push argv in a source file, with whatever it should not carry. */
export function pushArgvProblems(source) {
  const problems = [];
  const pattern = /\[\s*"push"/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match.index;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "[") depth += 1;
      else if (source[i] === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const argv = source.slice(open, end + 1);
    const line = source.slice(0, open).split("\n").length;
    for (const { token, why } of FORBIDDEN_PUSH_TOKENS) {
      // Matched as a whole quoted element, so `--force-with-lease` is not also
      // reported as `--force` and a BRANCH whose name contains the letters is
      // not reported at all.
      if (argv.includes(`"${token}"`)) problems.push({ line, token, why });
    }
    // A `+`-prefixed refspec is a force push wearing no flag to grep for.
    if (/"\+[^"]+:/.test(argv)) {
      problems.push({ line, token: "a +refspec", why: "a leading + on a refspec forces the update with no flag to grep for" });
    }
  }
  return problems;
}

/**
 * The shapes that matter, held to the standard the scans above set: a rule
 * never shown to fire has demonstrated nothing. The last two are the ways a
 * naive grep gets this wrong — an unrelated `.push(` call, and a BRANCH whose
 * name merely contains the letters.
 */
export const PUSH_ARGV_SAMPLES = [
  { flags: true, why: "the plain force", code: `git(cwd, ["push", "--force", "origin", branch]);` },
  { flags: true, why: "a lease is still an overwrite", code: `git(cwd, ["push", "--force-with-lease", "origin", branch]);` },
  { flags: true, why: "deleting a remote branch", code: `git(cwd, ["push", "origin", "--delete", branch]);` },
  { flags: true, why: "the short spelling", code: `git(cwd, ["push", "-f", "origin", branch]);` },
  { flags: true, why: "a +refspec forces with no flag to grep for", code: `git(cwd, ["push", "origin", "+refs/heads/x:refs/heads/x"]);` },
  {
    flags: true,
    why: "an argv built across several lines — the shape a line scan misses",
    code: `git(cwd, [\n  "push",\n  "--set-upstream",\n  "--force",\n  "origin",\n  branch,\n]);`,
  },
  { flags: false, why: "the one push this engine makes", code: `git(cwd, ["push", "--set-upstream", "origin", branch]);` },
  { flags: false, why: "an unrelated array push, which is not a git argv at all", code: `failures.push("--force is not allowed here");` },
  { flags: false, why: "a branch whose NAME contains the letters", code: `git(cwd, ["push", "--set-upstream", "origin", "telar/force-refresh"]);` },
];

// No `/warp/` import path and no warpScript|Runner|Spawn|Sandbox|Surface identifier. A bare `warp`
// stays (the loom brand in TelarMark.swift); no left word boundary, so `compileWarpScript` matches.
const RETIRED_WARP_PATH = /["'`][^"'`]*\/warp\/[^"'`]*["'`]/g;
const RETIRED_WARP_IDENTIFIER = /warp(Script|Runner|Spawn|Sandbox|Surface)\b/gi;

/** Every reference to the retired feature in one source text, with its line. */
export function retiredWarpReferences(source) {
  const hits = [];
  const at = (index) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(RETIRED_WARP_PATH)) {
    hits.push({ line: at(match.index), what: `a path through \`/warp/\` — ${match[0]}` });
  }
  for (const match of source.matchAll(RETIRED_WARP_IDENTIFIER)) {
    hits.push({ line: at(match.index), what: `the identifier \`${match[0]}\`` });
  }
  return hits;
}

// The silent rows carry the weight: the loom metaphor and look-alike words must not fire.
export const RETIRED_WARP_SAMPLES = [
  { flags: true, why: "the call site that broke the build", code: `import { compileWarpScript } from "./warp/sandbox";` },
  { flags: true, why: "the runner, imported from anywhere", code: `import { createWarpRunner } from "../../engine/src/warp/runner";` },
  { flags: true, why: "an identifier with no import at all — the shape a compiler cannot catch", code: `const spawn = createWarpSpawn({ cwd });` },
  { flags: true, why: "the verb-prefixed spellings, which a left-anchored \\b would miss", code: `const compiled = compileWarpScript(code);\nconst start = createWarpRunner(deps);` },
  { flags: true, why: "a type reference", code: `let surface: WarpSurface | undefined;` },
  { flags: true, why: "any case, since a re-add would not copy the old spelling", code: `const WARPRUNNER = 1;` },
  { flags: true, why: "a binding declared rather than imported", code: `type Bindings = { warpSpawn: unknown };` },

  { flags: false, why: "THE APP ICON — TelarMark's loom threads", code: `var warp = Path()\nwarp.move(to: CGPoint(x: 0, y: 0))` },
  { flags: false, why: "the icon's gradient id", code: `<linearGradient id="warp" x1="0" y1="0">` },
  { flags: false, why: "the weaving term in prose", code: `// Three bold warp strands and three bold weft strands interlock.` },
  { flags: false, why: "a dated record naming the retired feature", code: `// Measured on main: \`warp\` is 2,988 characters.` },
  { flags: false, why: "a directory that merely starts the same way", code: `import { x } from "./warping/thing";` },
  { flags: false, why: "a longer word containing the letters", code: `const warped = transform(image);` },
];

/** Every non-test source file under a directory. */
export async function sourceFilesUnder(directory) {
  const found = [];
  const walk = async (relative) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "release" || entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  await walk(directory);
  return found;
}

/** Every code file under a directory, tests included (a retired name can return through a fixture); DerivedData skipped. */
export async function codeFilesUnder(directory) {
  const found = [];
  const walk = async (relative) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "release" || entry.name === "DerivedData") continue;
        // `apps/engine/dist/` is the bundled engine build-app.sh writes and git
        // ignores. On CI it never exists; on a developer's Mac it can be days
        // stale, and a stale bundle still names whatever the source has since
        // retired (#877's scan tripped on exactly that). It is not source, and
        // nothing found in it could be fixed there.
        if (entry.name === "dist") continue;
        if (entry.name.startsWith(".next")) continue;
        await walk(next);
      } else if (/\.(tsx?|jsx?|mjs|cjs|swift)$/.test(entry.name)) {
        found.push(next);
      }
    }
  };
  await walk(directory);
  return found;
}

/** `import dynamic from "next/dynamic"`, however the binding is spelled. */
export const NEXT_DYNAMIC_IMPORT = /import\s+(?:\w+|\{[^}]*\}|\w+\s*,\s*\{[^}]*\})\s+from\s+["']next\/dynamic["']/;

// A bare `dynamic()` (no `ssr: false`, no `loading`) gets no Suspense from Next, so its file must render one.
// Paren-balanced since calls nest; per file because declaration and render site are far apart.
export function bareDynamicWithoutBoundary(source) {
  if (!NEXT_DYNAMIC_IMPORT.test(source)) return [];
  if (/<Suspense[\s/>]/.test(source)) return [];
  const hits = [];
  for (const match of source.matchAll(/\bdynamic\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let at = open; at < source.length; at += 1) {
      if (source[at] === "(") depth += 1;
      else if (source[at] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = at;
          break;
        }
      }
    }
    // An unbalanced call is a file this scan cannot read; say nothing rather
    // than guess, since the non-vacuity guard above is what catches a scan
    // that has stopped seeing its corpus.
    if (close === -1) continue;
    const call = source.slice(match.index, close + 1);
    if (/\bssr\s*:/.test(call) || /\bloading\s*:/.test(call)) continue;
    hits.push({ line: source.slice(0, match.index).split("\n").length, what: call.replace(/\s+/g, " ").slice(0, 80) });
  }
  return hits;
}

/** The shapes the scan above must and must not see. */
export const BARE_DYNAMIC_SAMPLES = [
  {
    flags: true,
    why: "a bare declaration in a file with no boundary anywhere — #896 itself",
    code: `import dynamic from "next/dynamic";\nconst Editor = dynamic(() => import("./editor").then((m) => m.Editor));\nexport const P = () => <Editor />;`,
  },
  {
    flags: false,
    why: "the same declaration in a file that renders a Suspense",
    code: `import dynamic from "next/dynamic";\nimport { Suspense } from "react";\nconst Editor = dynamic(() => import("./editor").then((m) => m.Editor));\nexport const P = () => <Suspense fallback={null}><Editor /></Suspense>;`,
  },
  {
    flags: false,
    why: "a self-closing boundary, which is still a boundary",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"));\nexport const P = () => <Suspense/>;`,
  },
  {
    flags: false,
    why: "`ssr: false`, which Next wraps itself",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"), { ssr: false });\nexport const P = () => <E />;`,
  },
  {
    flags: false,
    why: "a `loading` declaration, which Next also wraps itself",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e"), { loading: () => null });\nexport const P = () => <E />;`,
  },
  {
    flags: false,
    why: "a file that never imports next/dynamic, however much it says `dynamic(`",
    code: `const dynamic = (f) => f;\nconst E = dynamic(() => import("./e"));\nexport const P = () => <E />;`,
  },
  {
    flags: true,
    why: "a nested loader, which a `[^)]*` match would read as carrying no options and pass for the wrong reason",
    code: `import dynamic from "next/dynamic";\nconst E = dynamic(() => import("./e").then((m) => m.E));\nexport const P = () => <E />;`,
  },
];
