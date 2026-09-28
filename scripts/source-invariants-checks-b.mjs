import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { engineTestFiles, shardOf } from "./engine-shard.mjs";
import { bunTestScripts, bunTestTimeouts, CEILING_PRELOAD, markSizeArguments, read, ROOT, testPreloads, workspaceDirectories } from "./source-invariants-files.mjs";
import { BARE_DYNAMIC_SAMPLES, bareDynamicWithoutBoundary, codeFilesUnder, NEXT_DYNAMIC_IMPORT, PUSH_ARGV_SAMPLES, pushArgvProblems, RETIRED_WARP_SAMPLES, retiredWarpReferences, sourceFilesUnder } from "./source-invariants-scans.mjs";

export const CHECKS_GATES = [
  /**
   * The same standard #721 holds the font patterns to: a scan that has never
   * been shown to fail has demonstrated nothing. The nested-call sample is the
   * one that matters — it is the exact shape that defeated the first attempt.
   */
  {
    name: "ios-mark-sizes-self-test",
    protects: "#718: the mark-size scan still sees a literal through a nested call, and ignores a scaled one",
    async run() {
      const samples = [
        { fires: true, why: "the plain literal", code: `ProviderIconView(driver: d, size: 11)` },
        {
          fires: true,
          why: "a literal behind a nested call — the shape that defeated the first scan",
          code: `ProjectAvatar(name: p.name, api: settings.api(for: row.hostId), size: 13)`,
        },
        { fires: true, why: "spaced out", code: `ProviderIconView( driver: d , size:  12 )` },
        { fires: false, why: "a @ScaledMetric", code: `ProviderIconView(driver: d, size: badge)` },
        { fires: false, why: "a scaled metric behind a nested call", code: `ProjectAvatar(api: settings.api(for: h), size: slimProjectMark)` },
        { fires: false, why: "a computed size", code: `ProviderIconView(driver: d, size: box * 0.5)` },
        { fires: false, why: "some other view's literal size", code: `SomeOtherThing(size: 11)` },
      ];
      const failures = [];
      for (const { fires, why, code } of samples) {
        const hits = markSizeArguments(code);
        if (fires && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${JSON.stringify(code)}.`);
        }
        if (!fires && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${JSON.stringify(code)}. ` +
              "Flagging a scaled size makes the check wrong about correct code.",
          );
        }
      }
      return failures;
    },
  },

  // A preload's setDefaultTimeout reaches only a run's first test file, so multi-file scripts
  // still need `--timeout`, and every flag must carry the one ceiling. That the preload never
  // clamps an explicit flag is a behaviour, tested in test-ceiling.test.ts.
  {
    name: "test-ceiling-is-registered",
    protects: "#740/#792: every bunfig that runs tests preloads the one ceiling, and every bun test script carries it — no rival number, and none missing",
    async run() {
      const failures = [];
      const ceilingSource = await read(CEILING_PRELOAD).catch(() => null);
      if (ceilingSource === null) {
        return [
          `${CEILING_PRELOAD} is missing. It is where the per-test ceiling lives (#740); without it every suite is on ` +
            "bun's 5 s default and the bunfig preloads below point at nothing.",
        ];
      }
      const canonical = /export const TEST_CEILING_MS = ([0-9_]+);/.exec(ceilingSource);
      if (!canonical) {
        return [
          `${CEILING_PRELOAD} no longer declares \`export const TEST_CEILING_MS = <number>\`, so this check cannot read ` +
            "the canonical ceiling and must not pretend the numbers below agree with it. Restore the export, or teach " +
            "this check where the number moved to.",
        ];
      }
      const ceilingMs = Number(canonical[1].replace(/_/g, ""));

      for (const directory of await workspaceDirectories()) {
        const bunfig = directory ? `${directory}/bunfig.toml` : "bunfig.toml";
        const source = await read(bunfig).catch(() => null);
        if (source === null) continue;
        const preloads = testPreloads(source);
        if (preloads === null) continue; // no [test] table: bun reads nothing about tests from here
        const resolved = preloads.map((entry) => relative(ROOT, resolve(join(ROOT, directory), entry)).split("\\").join("/"));
        if (!resolved.includes(CEILING_PRELOAD)) {
          failures.push(
            `${bunfig} has a [test] table but does not preload ${CEILING_PRELOAD}. Tests run from this directory get ` +
              `bun's 5 s default instead of ${ceilingMs}ms, and nothing says so — that is #740 exactly. Add it to the ` +
              "preload list.",
          );
        }
        for (const [index, entry] of resolved.entries()) {
          const exists = await stat(join(ROOT, entry)).then(() => true).catch(() => false);
          if (exists) continue;
          failures.push(
            `${bunfig} preloads ${JSON.stringify(preloads[index])}, which does not exist. Bun fails the run on a ` +
              "missing preload, so this is loud rather than silent — but it is loud in every suite run from here.",
          );
        }
      }

      for (const directory of await workspaceDirectories()) {
        const manifest = directory ? `${directory}/package.json` : "package.json";
        const source = await read(manifest).catch(() => null);
        if (source === null) continue;
        let scripts;
        try {
          scripts = JSON.parse(source).scripts;
        } catch {
          failures.push(`${manifest} is not valid JSON, so this check cannot read its scripts.`);
          continue;
        }
        for (const { script, command } of bunTestScripts(scripts)) {
          if (/--timeout[= ]+[0-9_]+/.test(command)) continue;
          failures.push(
            `${manifest}: \`${script}\` runs \`bun test\` with no --timeout, so every file after the FIRST one it ` +
              `loads is on bun's 5000ms default (#792). The preload cannot cover this: bun applies a preload's ` +
              `setDefaultTimeout to the first file only, which is how #740 left the 182-file engine suite running at ` +
              `5 s while reporting ${ceilingMs}. Add \`--timeout ${ceilingMs}\`.`,
          );
        }
        for (const { script, ms } of bunTestTimeouts(scripts)) {
          if (ms === ceilingMs) continue;
          failures.push(
            `${manifest}: \`${script}\` passes --timeout ${ms}, but the repo's ceiling is ${ceilingMs}ms ` +
              `(${CEILING_PRELOAD}). A flag on a script still works — the preload stands aside for an explicit one — ` +
              `which is exactly why a rival number is a problem: this suite would run at ${ms}ms while the same test ` +
              `run any other way runs at ${ceilingMs}ms, and the difference is invisible in the failure. Match the ` +
              `canonical number, or change it in ${CEILING_PRELOAD}, where every invocation reads it.`,
          );
        }
      }
      return failures;
    },
  },

  // Samples: the desktop script's hand-typed and globbed shapes, and `//` comment keys.
  {
    name: "test-ceiling-scan-self-test",
    protects: "#740/#792: the script scan sees a flag through either desktop shape, sees a bun test run without one, and ignores prose about both",
    async run() {
      const samples = [
        { expect: [20_000], why: "the glob shape (#763)", scripts: { t: "bun test --timeout 20000 ./*.test.js" } },
        { expect: [20_000], why: "the hand-listed shape it replaced", scripts: { t: "bun test --timeout 20000 ./a.test.js ./b.test.js" } },
        { expect: [20_000], why: "the = spelling", scripts: { t: "bun test --timeout=20000" } },
        { expect: [5_000], why: "a rival number", scripts: { t: "bun test --timeout 5000" } },
        { expect: [], why: "an env prefix and no flag", scripts: { t: "NODE_ENV=test bun test" } },
        { expect: [], why: "a bare run", scripts: { t: "bun test" } },
        { expect: [], why: "delegation to another script", scripts: { t: "bun run test:desktop:unit" } },
        { expect: [], why: "an electron suite", scripts: { t: "env -u ELECTRON_RUN_AS_NODE electron ./x.electron-test.js" } },
        { expect: [], why: "prose in a // comment key", scripts: { "//t": "--timeout IS THE ONLY WAY, bun test aside" } },
        { expect: [], why: "node's runner rather than bun's", scripts: { t: "node --test workers/push-relay/worker.test.mjs" } },
      ];
      const failures = [];
      for (const { expect: wanted, why, scripts } of samples) {
        const got = bunTestTimeouts(scripts).map((hit) => hit.ms);
        if (JSON.stringify(got) === JSON.stringify(wanted)) continue;
        failures.push(
          `the scan read ${JSON.stringify(got)} where ${JSON.stringify(wanted)} was right (${why}): ` +
            `${JSON.stringify(Object.values(scripts)[0])}.`,
        );
      }

      // Delegating scripts and other runners must not be read as running bun test.
      const runners = [
        { expect: ["t"], why: "a bare run is still a bun test run", scripts: { t: "bun test" } },
        { expect: ["t"], why: "an env prefix does not hide it", scripts: { t: "NODE_ENV=test bun test" } },
        { expect: ["t"], why: "the flag present is still a bun test run", scripts: { t: "bun test --timeout 20000" } },
        { expect: [], why: "delegation to another script", scripts: { t: "bun run test:desktop:unit" } },
        { expect: [], why: "an electron suite", scripts: { t: "env -u ELECTRON_RUN_AS_NODE electron ./x.electron-test.js" } },
        { expect: [], why: "node's runner rather than bun's", scripts: { t: "node --test workers/push-relay/worker.test.mjs" } },
        { expect: [], why: "prose in a // comment key", scripts: { "//t": "--timeout IS THE ONLY WAY, bun test aside" } },
      ];
      for (const { expect: wanted, why, scripts } of runners) {
        const got = bunTestScripts(scripts).map((hit) => hit.script);
        if (JSON.stringify(got) === JSON.stringify(wanted)) continue;
        failures.push(
          `the runner scan read ${JSON.stringify(got)} where ${JSON.stringify(wanted)} was right (${why}): ` +
            `${JSON.stringify(Object.values(scripts)[0])}.`,
        );
      }
      return failures;
    },
  },

  // verify.yml's shard list is read, not trusted: a raised total with a stale list silently skips files.
  {
    name: "engine-shards-cover-every-test-file",
    protects: "#760: verify.yml's engine shard matrix and scripts/engine-shard.mjs partition every engine test file — union whole, none shared, none empty",
    async run() {
      const workflow = await read(".github/workflows/verify.yml").catch(() => null);
      if (workflow === null) return [".github/workflows/verify.yml is missing, so the engine shard matrix cannot be read."];

      const job = /\n {2}test-engine:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/.exec(workflow);
      if (!job) {
        return [
          "verify.yml no longer has a `test-engine:` job, so the engine suite is either unsharded or sharded " +
            "somewhere this check cannot see. If the split moved, teach this check where — an unchecked split is " +
            "how a shard starts dropping files without a red run (#760).",
        ];
      }
      const block = job[1];

      const failures = [];
      const shardAxis = /\n {8}shard: \[([0-9, ]+)\]\n/.exec(block);
      const totalAxis = /\n {8}total: \[([0-9]+)\]\n/.exec(block);
      if (!shardAxis || !totalAxis) {
        return [
          "verify.yml's `test-engine` job no longer declares both `shard: [ ... ]` and `total: [ N ]` matrix axes in " +
            "the shape this check reads. They are what tie the workflow's split to the one the script computes.",
        ];
      }
      const shards = shardAxis[1].split(",").map((entry) => Number(entry.trim()));
      const total = Number(totalAxis[1]);

      const wanted = Array.from({ length: total }, (_unused, at) => at + 1);
      if (JSON.stringify(shards) !== JSON.stringify(wanted)) {
        failures.push(
          `verify.yml runs engine shards ${JSON.stringify(shards)} out of a split of ${total}, which is not ` +
            `${JSON.stringify(wanted)}. Every shard of the split must run: the ones missing here are test files that ` +
            "no job opens, and the jobs that do run are green.",
        );
      }
      if (!/- run: bun scripts\/engine-shard\.mjs \$\{\{ matrix\.shard \}\} \$\{\{ matrix\.total \}\}/.test(block)) {
        failures.push(
          "verify.yml's `test-engine` job no longer runs `bun scripts/engine-shard.mjs ${{ matrix.shard }} " +
            "${{ matrix.total }}`. The matrix axes above are only meaningful if they are what the script is handed.",
        );
      }
      // Split rather than a \bengine\b word match: `engine-client` is a suite of
      // its own and a word boundary sits on the hyphen, so the naive pattern
      // reports the double-run that is not there.
      const suiteAxis = /\n {8}suite: \[([^\]]*)\]/.exec(workflow);
      const suites = suiteAxis ? suiteAxis[1].split(",").map((entry) => entry.trim()) : [];
      if (suites.includes("engine")) {
        failures.push(
          "verify.yml's `test` matrix still lists `engine` alongside the sharded `test-engine` job, so the engine " +
            "suite runs twice — once whole and once split. That is not wrong so much as invisible: the sharded jobs " +
            "could be dropping files and the whole-suite job would keep the run green.",
        );
      }
      if (!/needs: \[[^\]]*\btest-engine\b[^\]]*\]/.test(workflow)) {
        failures.push(
          "verify.yml's `verify-passed` job does not list `test-engine` in `needs`, so a red engine shard does not " +
            "stop the aggregate going green. A required check that cannot fail is the #772 shape.",
        );
      }

      const files = await engineTestFiles();
      const parts = wanted.map((index) => shardOf(files, index, total));
      const covered = parts.flat();
      const union = new Set(covered);
      const empty = wanted.filter((index) => parts[index - 1].length === 0);
      if (empty.length > 0) {
        failures.push(
          `engine shards ${JSON.stringify(empty)} of ${total} are empty. An empty shard is a green job that ran ` +
            "nothing, which reads as a pass.",
        );
      }
      if (covered.length !== union.size) {
        const twice = covered.filter((file, at) => covered.indexOf(file) !== at);
        failures.push(
          `these engine test files are in more than one shard: ${JSON.stringify([...new Set(twice)])}. Duplicated ` +
            "work is the harmless half of a broken partition; the other half is usually a gap.",
        );
      }
      const missed = files.filter((file) => !union.has(file));
      if (missed.length > 0) {
        failures.push(
          `these engine test files are in no shard, so nothing in CI runs them: ${JSON.stringify(missed)}. That is ` +
            "coverage lost with every job still green, which is exactly what #760's split had to not do.",
        );
      }
      return failures;
    },
  },

  /**
   * #721 again: the partition above is checked against the real tree, where it
   * has always held, so it has never been seen to fail. These samples are where
   * it is made to.
   */
  {
    name: "engine-shard-partition-self-test",
    protects: "#760: the shard function partitions — every item once, nothing invented, no shard left empty when there is work",
    async run() {
      const failures = [];
      const files = Array.from({ length: 7 }, (_unused, at) => `test/f${at}.test.ts`);
      for (const total of [1, 2, 3, 7]) {
        const parts = Array.from({ length: total }, (_unused, at) => shardOf(files, at + 1, total));
        const covered = parts.flat();
        if (covered.length !== files.length || new Set(covered).size !== files.length) {
          failures.push(`a split of ${total} over ${files.length} files covered ${JSON.stringify(covered)} — not a partition.`);
        }
        if (parts.some((part) => part.length === 0)) {
          failures.push(`a split of ${total} over ${files.length} files left an empty shard: ${JSON.stringify(parts)}.`);
        }
      }
      // More shards than files: some shards ARE empty, and the script refuses to
      // run one rather than reporting a green job that opened nothing.
      const sparse = shardOf(files, 9, 9);
      if (sparse.length !== 0) failures.push(`shard 9 of 9 over 7 files should be empty, got ${JSON.stringify(sparse)}.`);
      // And an index outside the split is a throw, not a quietly empty list.
      for (const [index, total] of [[0, 3], [4, 3], [1, 0]]) {
        let threw = false;
        try {
          shardOf(files, index, total);
        } catch {
          threw = true;
        }
        if (!threw) failures.push(`shardOf(files, ${index}, ${total}) returned instead of throwing; an impossible shard must not look empty.`);
      }
      return failures;
    },
  },
  {
    name: "git-push-argv-self-test",
    protects: "#670: the push-argv scan still fires on every way of forcing, and stays quiet on the one push this engine makes",
    async run() {
      const failures = [];
      for (const sample of PUSH_ARGV_SAMPLES) {
        const hits = pushArgvProblems(sample.code);
        const shown = sample.code.replace(/\n/g, " ");
        if (sample.flags && hits.length === 0) failures.push(`the scan missed ${sample.why}: ${shown}`);
        if (!sample.flags && hits.length > 0) failures.push(`the scan fired on ${sample.why}: ${shown}`);
      }
      return failures;
    },
  },
  {
    name: "git-push-argv",
    protects: "#670: no git push in the engine carries --force, --force-with-lease, --delete or a +refspec",
    async run() {
      const failures = [];
      for (const file of await sourceFilesUnder("apps/engine/src")) {
        const source = await readFile(join(ROOT, file), "utf8");
        for (const problem of pushArgvProblems(source)) {
          failures.push(
            `${file}:${problem.line}: a git push argv carries \`${problem.token}\` — ${problem.why}.\n` +
              "        `git.ts`'s header argues this engine's one push is inside the additive-and-recoverable rule on " +
              "exactly the ground that it cannot destroy what was already on the remote. A second push that can is not " +
              "a new feature; it retires that argument. If this is genuinely wanted, the header is what has to change first.",
          );
        }
      }
      return failures;
    },
  },

  {
    name: "warp-stays-retired-self-test",
    protects: "#877: the scan still catches both shapes of a Warp reference, and stays silent on the app icon's loom threads",
    async run() {
      const failures = [];
      for (const { flags, why, code } of RETIRED_WARP_SAMPLES) {
        const hits = retiredWarpReferences(code);
        const shown = JSON.stringify(code);
        if (flags && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${shown}. warp-stays-retired below is now green for a shape it no longer sees.`);
        }
        if (!flags && hits.length > 0) {
          failures.push(
            `the scan FIRED on a sample it must ignore (${why}): ${shown}. ` +
              "Telar is a loom and `warp` is one of its threads — a guard that flags the app icon is one the next person deletes rather than argues with.",
          );
        }
      }
      return failures;
    },
  },
  {
    name: "warp-stays-retired",
    protects: "#877: no file under apps/, packages/ or workers/ imports through `/warp/` or names a warpScript/Runner/Spawn/Sandbox/Surface",
    async run() {
      const failures = [];
      let scanned = 0;
      for (const group of ["apps", "packages", "workers"]) {
        for (const file of (await codeFilesUnder(group)).sort()) {
          scanned += 1;
          for (const hit of retiredWarpReferences(await read(file))) {
            failures.push(
              `${file}:${hit.line}: ${hit.what} — Warp was retired in #877 and may not come back.\n` +
                "        The owner asked for it to go completely, with no chance of using it again: the tool, the four " +
                "`src/warp/` modules, the protocol linkage and the surfaces that rendered it are all gone, and the tool " +
                "walls are pinned WITHOUT it in `domains/agent-tools/tool-names.test.ts` and `domains/agent-tools/budgets.test.ts`. If a fan-out is genuinely " +
                "wanted again, that is a decision for the owner and a new name, not a resurrection of this one.\n" +
                "        If you are reading this because of the LOOM — Telar's warp-and-weft mark — you have hit a bug in " +
                "this check rather than the rule: a bare `warp` is deliberately allowed, and only the five suffixed " +
                "identifiers and a path through `/warp/` are not.",
            );
          }
        }
      }
      // An empty result from a scan is a claim about the scan. If the walker
      // stopped finding files, this check would pass by reading nothing — the
      // failure mode that looks exactly like success.
      if (scanned === 0) {
        failures.push("no code file was found under apps/, packages/ or workers/, which cannot be right — codeFilesUnder() has stopped walking, so this check is green because it read nothing.");
      }
      return failures;
    },
  },

  {
    name: "dynamic-render-sites-have-a-boundary-self-test",
    protects: "#896: the scan still fires on a bare `dynamic()` with no Suspense, and stays quiet on the two declarations that bring their own",
    async run() {
      const failures = [];
      for (const { flags, why, code } of BARE_DYNAMIC_SAMPLES) {
        const hits = bareDynamicWithoutBoundary(code);
        const shown = JSON.stringify(code);
        if (flags && hits.length === 0) {
          failures.push(`the scan MISSED a sample it must catch (${why}): ${shown}. dynamic-render-sites-have-a-boundary below is now green for a shape it no longer sees.`);
        }
        if (!flags && hits.length > 0) {
          failures.push(`the scan FIRED on a sample it must ignore (${why}): ${shown}. A guard that flags a declaration Next already wraps is one the next person deletes rather than argues with.`);
        }
      }
      return failures;
    },
  },
  {
    name: "dynamic-render-sites-have-a-boundary",
    protects: "#896: a file that declares a bare next/dynamic also declares the Suspense that catches its first render",
    async run() {
      const failures = [];
      const files = await sourceFilesUnder("apps/web");
      let declaring = 0;
      for (const file of files.sort()) {
        const source = await read(file);
        if (!NEXT_DYNAMIC_IMPORT.test(source)) continue;
        declaring += 1;
        for (const hit of bareDynamicWithoutBoundary(source)) {
          failures.push(
            `${file}:${hit.line}: \`${hit.what}\` is declared with neither \`ssr: false\` nor \`loading\`, and this file renders no \`<Suspense>\`.\n` +
              "        Next then adds no boundary, so the first render of an unfetched chunk suspends the whole route to its loading.tsx.\n" +
              "        Wrap the render site in `<Suspense fallback={null}>`.",
          );
        }
      }

      // A walk that stopped walking or a pattern that stopped matching would look like a clean tree.
      if (files.length === 0) {
        return ["apps/web: sourceFilesUnder() returned nothing, so this check swept no files and proved nothing. Fix the walk rather than trusting the pass."];
      }
      if (declaring === 0) {
        return [
          `apps/web: scanned ${files.length} source files and found none importing next/dynamic, which cannot be true while the panel, the settings panes, the sidebar and the annotate overlay are all code-split. Either the import was spelled a new way or NEXT_DYNAMIC_IMPORT has rotted; either way this check is now vacuous and must be re-anchored, not removed.`,
        ];
      }
      return failures;
    },
  },
];
