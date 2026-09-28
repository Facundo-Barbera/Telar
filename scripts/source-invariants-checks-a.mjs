import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { absoluteSizesIn, GUARD_SAMPLES, markSizeArguments, read, ROOT, SHARED_WAIT_MODULE, SWEPT_FILES, testFilesUnder, waitBudgetFailure } from "./source-invariants-files.mjs";
import { ARRAY_GUARD_SAMPLES, enablesNounset, shellFiles, SYNC_SPAWN_SAMPLES, syncSpawnCalls, unguardedArrayExpansions, WORKFLOW_BLOCK_SAMPLES, workflowBlockHits, workflowFiles, workflowRunBlocks } from "./source-invariants-scans.mjs";

export const CHECKS_SCANS = [
  // spawnSync blocks the event loop, so bun's per-test timer cannot bound it;
  // every engine-test call site names its own timeout and SIGKILL.
  {
    name: "engine-test-spawn-sync-is-bounded",
    protects: "#807: no synchronous child wait in the engine suite can outlive its own call site",
    async run() {
      const failures = [];
      for (const file of (await testFilesUnder("apps/engine")).sort()) {
        for (const call of syncSpawnCalls(await read(file))) {
          if (call.bounded && call.forceful) continue;
          const missing = call.bounded ? '`killSignal: "SIGKILL"`' : call.forceful ? "a `timeout`" : "a `timeout` and `killSignal: \"SIGKILL\"`";
          failures.push(
            `${file}:${call.line}: \`${call.call}(…)\` is missing ${missing}. A synchronous child wait blocks the JS thread in wait4, ` +
              "where bun's per-test ceiling — an event-loop timer — can never reach it, so a child that does not exit is a test that never " +
              "fails and a `bun test` that never ends. Give this call site a ceiling it knows is generous for what it spawns, and SIGKILL " +
              "so the ceiling reaches a child that has stopped answering. See src/platform/git/runner.ts's sync git runner for the shape.",
          );
        }
      }
      return failures;
    },
  },

  {
    name: "engine-test-spawn-sync-scan-self-test",
    protects: "#807: the scan still fires on both unbounded spellings, and stays quiet on a bounded call whose options are lines below it",
    async run() {
      const failures = [];
      for (const { flags, why, code } of SYNC_SPAWN_SAMPLES) {
        const unbounded = syncSpawnCalls(code).filter((call) => !(call.bounded && call.forceful));
        if (flags && unbounded.length === 0) failures.push(`the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}.`);
        if (!flags && unbounded.length > 0) {
          failures.push(`the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. Flagging a bounded call makes the check wrong about correct code.`);
        }
      }
      return failures;
    },
  },

  {
    name: "shell-empty-array-self-test",
    protects:
      "#808/#829: the scan below still fires on the shape that broke, stays quiet on the fix, and reads a workflow `run:` block at the line it really has",
    async run() {
      const failures = [];
      for (const { why, hits: expected, scanned: expectedScanned, yaml } of WORKFLOW_BLOCK_SAMPLES) {
        const blocks = workflowRunBlocks(yaml.join("\n"));
        const found = [];
        let scanned = 0;
        for (const block of blocks) {
          const hits = workflowBlockHits(block);
          if (hits === null) continue;
          scanned += 1;
          found.push(...hits.map((hit) => `${hit.line}:${hit.name}`));
        }
        if (found.join(", ") !== expected.join(", ")) {
          failures.push(
            `the workflow reader saw [${found.join(", ")}] where it must see [${expected.join(", ")}] (${why}). ` +
              "A reader that reports the wrong line sends the next person to text that says nothing about the failure, " +
              "and one that reports nothing makes shell-empty-array green over `.github/workflows` for free.",
          );
        }
        if (scanned !== expectedScanned) {
          failures.push(
            `the workflow reader scanned ${scanned} block(s) where it must scan ${expectedScanned} (${why}). ` +
              "Blocks scanned is what shell-empty-array's non-vacuity rule counts, so this number moving silently is " +
              "how that rule stops meaning anything.",
          );
        }
      }
      for (const { flags, why, code } of ARRAY_GUARD_SAMPLES) {
        const hits = unguardedArrayExpansions(code);
        if (flags && hits.length === 0) {
          failures.push(
            `the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}. ` +
              "shell-empty-array below is now reporting green for a spelling it no longer sees.",
          );
        }
        if (!flags && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. ` +
              "This spelling is safe on bash 3.2; flagging it makes the check wrong about correct code, and the " +
              "next person to hit it will delete the check rather than argue with it.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "shell-empty-array",
    protects:
      "#808/#829: no `set -u` shell script or workflow `run:` block expands an array that could be empty, which aborts on the bash macOS ships",
    async run() {
      const failures = [];
      const report = (where, hit, closing) =>
        failures.push(
          `${where}: \`${hit.name}\` is expanded without a guard — ${hit.text}\n` +
            `        Write it as \${${hit.name}[@]+"\${${hit.name}[@]}"} (or \${${hit.name}[*]-} inside a message ` +
            "string). Under `set -u` bash 3.2 treats an expansion of an EMPTY array as an unbound variable and " +
            `kills the ${closing} Bash 4.4 stopped doing this, which is why it will very likely ` +
            "work when you try it. Do not reach for `set +u` (it drops the check for every variable on the line) " +
            "or for seeding the array (the seed becomes a real argument to the command).",
        );

      let scanned = 0;
      for (const path of await shellFiles()) {
        const source = await read(path);
        if (!enablesNounset(source)) continue;
        scanned += 1;
        for (const hit of unguardedArrayExpansions(source)) {
          report(
            `${path}:${hit.line}`,
            hit,
            "script; macOS ships 3.2.57 as /bin/bash, so `#!/usr/bin/env bash` gets it on any machine " +
              "without a newer bash earlier on PATH.",
          );
        }
      }

      let blocksScanned = 0;
      for (const path of await workflowFiles()) {
        const source = await read(path);
        for (const block of workflowRunBlocks(source)) {
          const hits = workflowBlockHits(block);
          if (hits === null) continue;
          blocksScanned += 1;
          for (const hit of hits) {
            report(
              `${path}:${hit.line}`,
              hit,
              "step; the `macos-*` runner images report bash 3.2.57 as their `bash`, and a `run:` block takes " +
                "its shell from PATH, so this is the bash the step gets.",
            );
          }
        }
      }

      // An empty result from a scan is a claim about the scan. If the walker
      // stopped finding shell scripts, this check would pass by finding nothing
      // to check — the failure mode that looks exactly like success. The same
      // holds a second time for workflows, where the reader has a YAML shape to
      // get wrong as well as a directory to find.
      if (scanned === 0) {
        failures.push(
          "no `set -u` shell script was found anywhere in the tree, which cannot be right — " +
            "shellFiles() has stopped walking, so this check is green because it read nothing.",
        );
      }
      if (blocksScanned === 0) {
        failures.push(
          "no `set -u` `run:` block was found in .github/workflows, which cannot be right — " +
            "workflowRunBlocks() has stopped reading the YAML, so the workflow half of this check is green " +
            "because it read nothing.",
        );
      }
      return failures;
    },
  },
  {
    name: "ios-type-scale-self-test",
    protects: "#721: the absolute-size patterns still fire on what they claim, and stay quiet on correct code",
    async run() {
      const failures = [];
      for (const { fires, why, code } of GUARD_SAMPLES) {
        const hits = absoluteSizesIn(code);
        if (fires && hits.length === 0) {
          failures.push(
            `the guard MISSED a sample it must catch (${why}): ${JSON.stringify(code)}. ` +
              "A pattern in ABSOLUTE_SIZES has stopped matching, so ios-type-scale below is now reporting green " +
              "for a spelling it no longer sees.",
          );
        }
        if (!fires && hits.length > 0) {
          failures.push(
            `the guard FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)} — matched ${hits.join(", ")}. ` +
              "This spelling scales; flagging it makes the guard wrong about correct code, and the next person to " +
              "hit it will delete the pattern rather than argue with it.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "ios-type-scale",
    protects: "the Dynamic Type sweep (#248, #674, #721): no swept iOS file holds an absolute font size",
    async run() {
      const failures = [];
      for (const [path, note] of SWEPT_FILES) {
        let source;
        try {
          source = await read(path);
        } catch {
          failures.push(`${path}: listed as swept but the file is missing — was it moved or renamed?`);
          continue;
        }
        const hits = absoluteSizesIn(source);
        if (hits.length === 0) continue;
        const spellings = [...new Set(hits)].join(", ");
        failures.push(
          `${path}: ${hits.length} absolute font size${hits.length === 1 ? "" : "s"} (${spellings}). ` +
            "Use a Dynamic Type style (Theme.captionTiny/caption/footnote/subhead), or — if the number has to survive, " +
            "as it does for a glyph locked in a fixed frame — a named @ScaledMetric seeded with it, which keeps the " +
            "size and still scales; see apps/ios/TelarMobile/UI/ScaledFrame.swift. In UIKit the scaling paths are " +
            "UIFont.preferredFont(forTextStyle:) and UIFontMetrics — if this IS a UIFontMetrics call split across " +
            `lines, put it on one line and the guard will read it correctly.${note ? ` (note on this file: ${note})` : ""}`,
        );
      }
      return failures;
    },
  },
  // A Swift test reading `#filePath` only resolved on the build machine, so this lives here.
  {
    name: "ios-transcript-order",
    protects:
      "the transcript's render order (#675): TranscriptViews draws a boundary before the work under it",
    async run() {
      const path = "apps/ios/TelarMobile/Features/Transcript/TranscriptViews.swift";
      let source;
      try {
        source = await read(path);
      } catch {
        return [`${path} is missing — if the view moved, point this check at its new path.`];
      }

      // Every anchor is load-bearing. A check cannot conclude anything about
      // an order it could not locate, so a vanished anchor is a failure and
      // never a silent pass — what the `#require`s did in the Swift original.
      const find = (needle, haystack) => {
        const at = haystack.indexOf(needle);
        return at === -1 ? null : at;
      };

      const loop = find("ForEach(Array(earlier.enumerated())", source);
      const answering = find("if let boundary = answering.boundary", source);
      const absent = [];
      if (loop === null) absent.push("the ForEach over `earlier`");
      if (answering === null) absent.push("the answering response's `if let boundary`");
      if (absent.length > 0) {
        return [
          `${path}: cannot find ${absent.join(" or ")}, so the render order cannot be checked at all. If the view was restructured, re-anchor this check in scripts/source-invariants.mjs rather than dropping it — it is the only thing pinning the view to turnRenderOrder.`,
        ];
      }
      if (answering < loop) {
        return [
          `${path}: the answering response's boundary is drawn before the loop over earlier responses. Finished work comes first, then the response being answered — see turnRenderOrder.`,
        ];
      }

      const failures = [];

      // Scoped to the loop body, so the `response.boundary` further down the
      // file — a different scope, in turnRenderOrder itself — cannot stand in
      // for the one that is supposed to be inside it.
      const body = source.slice(loop, answering);
      const eachBoundary = find("if let boundary = response.boundary", body);
      const eachWork = find("LiveActivityView(items: response.items", body);
      if (eachBoundary === null || eachWork === null) {
        failures.push(
          `${path}: the loop over earlier responses no longer draws ${
            eachBoundary === null ? "its boundary" : "its work"
          }. Each finished response is a boundary followed by the work under it; if that changed, re-anchor this check.`,
        );
      } else if (eachBoundary > eachWork) {
        failures.push(
          `${path}: inside the loop over earlier responses, LiveActivityView is drawn before the boundary it belongs to. A boundary introduces the work under it — move ItemRowView(item: boundary) above LiveActivityView.`,
        );
      }

      const live = find("LiveActivityView(items: answering.items", source);
      if (live === null) {
        failures.push(
          `${path}: the answering response's LiveActivityView is gone, so nothing pins that its boundary is drawn before the work answering it. Re-anchor this check if the live tail was restructured.`,
        );
      } else if (answering > live) {
        failures.push(
          `${path}: the answering response's work is drawn before its own boundary. The message that opened the response comes first — move the \`if let boundary = answering.boundary\` block above LiveActivityView(items: answering.items.`,
        );
      }

      return failures;
    },
  },

  // The shared helper derives its budget from DEFAULT_GIT_TIMEOUT_MS; a private copy
  // freezes an idle-machine number and fails under load.
  {
    name: "worktree-wait-is-shared",
    protects: "the wait for a session's checkout (#706): one derived budget, not a copy per suite",
    async run() {
      const failures = [];
      const helpers = (await readdir(join(ROOT, "apps/engine/test"))).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "worktree-ready.ts");
      const files = [...helpers.map((name) => `apps/engine/test/${name}`), ...(await testFilesUnder("apps/engine"))];
      for (const file of files) {
        const source = await read(file);
        if (!/preparation\?\.state/.test(source)) continue;
        if (!/for \([^)]*\)\s*\{[\s\S]{0,200}?preparation\?\.state/.test(source)) continue;
        failures.push(
          `${file}: this file polls \`preparation?.state\` in its own loop instead of using \`worktreeReady\` from ./worktree-ready. That copy carries its own ceiling, and a fixed ceiling against the suite-wide git pool is what #706 is. Import the shared helper; if you truly need a different bound, import WORKTREE_READY_TIMEOUT_MS and say why.`,
        );
      }
      return failures;
    },
  },

  // happy-dom's GlobalRegistrator is process-wide and throws on a second register, so a
  // file that never unregisters fails whichever file bun loads after it.
  {
    name: "web-test-dom-release",
    protects:
      "the web suite's shared process (#719): a test file that registers happy-dom also unregisters it",
    async run() {
      const files = await testFilesUnder("apps/web");
      const registers = [];
      const unbalanced = [];
      for (const path of files) {
        const source = await read(path);
        if (!/GlobalRegistrator\s*\.\s*register\s*\(/.test(source)) continue;
        registers.push(path);
        if (!/GlobalRegistrator\s*\.\s*unregister\s*\(/.test(source)) unbalanced.push(path);
      }

      // Non-vacuity first: a rotted walk that sees nothing would otherwise report ok forever.
      if (files.length === 0) {
        return [
          "apps/web: found no *.test.ts(x) files at all, so this check swept nothing and proved nothing. The walk in testFilesUnder has stopped matching — fix it in scripts/source-invariants.mjs rather than trusting the pass.",
        ];
      }
      if (registers.length === 0) {
        return [
          `apps/web: scanned ${files.length} test files and found none that call GlobalRegistrator.register, which cannot be true while this app has DOM tests. Either the call was renamed or the pattern here has rotted; either way this check is now vacuous and must be re-anchored, not removed.`,
        ];
      }

      return unbalanced.map(
        (path) =>
          `${path}: registers happy-dom and never unregisters it. Add \`afterAll(async () => { await GlobalRegistrator.unregister(); });\` — the registration is process-wide, so the file this breaks is the NEXT one to register, not this one, and the error it throws names that file instead. ${registers.length - unbalanced.length} other file${registers.length - unbalanced.length === 1 ? "" : "s"} in apps/web already pair the two.`,
      );
    },
  },
  // A call-site `size: 11` on these two proportional views does not scale with the row's text.
  // Paren-balanced because the calls nest and `[^)]*` stops at the inner `)`.
  {
    name: "ios-mark-sizes",
    protects: "#718: a project or provider mark is never pinned to a literal at its call site",
    async run() {
      const failures = [];
      for (const [path] of SWEPT_FILES) {
        let source;
        try {
          source = await read(path);
        } catch {
          continue; // the type-scale check above already reports a missing file
        }
        for (const { line, name, value } of markSizeArguments(source)) {
          failures.push(
            `${path}:${line}: ${name}(… size: ${value}) is pinned to a literal. Both views are proportional to the ` +
              "size they are given, so the caller decides whether the mark scales — and a hard number means it does " +
              "not, while the text beside it does. Give it a @ScaledMetric relative to the style of the text it sits " +
              "next to (not one shared reference: a mark tracks its own line). See SessionSidebar.swift.",
          );
        }
      }
      return failures;
    },
  },

  // A file's largest wait budget, the shared module's included when imported, must be strictly
  // under its smallest per-test ceiling, or the test dies mid-wait and hides the reason.
  {
    name: "test-wait-fits-its-ceiling",
    protects: "engine test timeouts (#706, #760): a wait's budget — its own or the shared helper's — is strictly under the ceiling of the test running it",
    async run() {
      const shared = await read(SHARED_WAIT_MODULE).catch(() => null);
      if (shared === null) {
        return [
          `${SHARED_WAIT_MODULE} is missing. It is where the one wait budget lives (#760); without it this check ` +
            "cannot tell what budget the files importing it are running under, and must not pretend otherwise.",
        ];
      }
      const declared = /export const WAIT_BUDGET_MS = ([0-9_]+);/.exec(shared);
      if (!declared) {
        return [
          `${SHARED_WAIT_MODULE} no longer declares \`export const WAIT_BUDGET_MS = <number>\` as a plain literal, so ` +
            "this check cannot read the shared budget. Restore the declaration, or teach this check where it moved to.",
        ];
      }
      const sharedBudgetMs = Number(declared[1].replace(/_/g, ""));

      const failures = [];
      for (const file of await testFilesUnder("apps/engine")) {
        const failure = waitBudgetFailure(file, await read(file), sharedBudgetMs);
        if (failure) failures.push(failure);
      }
      return failures;
    },
  },

  /**
   * #721's standard, applied to the scan above: one that has never been shown to
   * fail has demonstrated nothing. The sample that matters is the third — a file
   * whose budget is entirely in the shared module, which is the exact shape the
   * old scan read as "no budget here" and passed.
   */
  {
    name: "test-wait-scan-self-test",
    protects: "#706/#760: the wait-budget scan still sees an inverted pair through the shared helper, and stays quiet on a correct one",
    async run() {
      const ceiling = (ms) => `test("x", async () => {\n  await eventually(() => {});\n}, ${ms});\n`;
      const importsShared = 'import { eventually } from "./wait";\n';
      const localBudget = "const deadlineMs = 15_000;\n";
      const samples = [
        { fires: true, why: "the original #706 shape: a local 15s budget under a 10s ceiling", source: localBudget + ceiling(10_000) },
        { fires: true, why: "equal is a coin toss, not a pass", source: localBudget + ceiling(15_000) },
        { fires: true, why: "the budget moved into the shared module and the ceiling did not move with it", source: importsShared + ceiling(10_000) },
        { fires: true, why: "the same, from a test beside its source under src/", source: 'import { eventually } from "../../test/wait";\n' + ceiling(10_000) },
        { fires: false, why: "the shared budget under the suite ceiling", source: importsShared + ceiling(20_000) },
        { fires: false, why: "a local budget under its ceiling", source: localBudget + ceiling(20_000) },
        { fires: false, why: "no ceiling at all inherits the suite's 20s", source: importsShared },
        { fires: false, why: "a file with neither a budget nor an import", source: ceiling(10_000) },
      ];
      const failures = [];
      for (const { fires, why, source } of samples) {
        const failure = waitBudgetFailure("sample.test.ts", source, 15_000);
        if (fires && failure === null) failures.push(`the scan MISSED a sample it must catch (${why}).`);
        if (!fires && failure !== null) failures.push(`the scan FIRED on a sample it must ignore (${why}): ${failure}`);
      }
      return failures;
    },
  },

];
