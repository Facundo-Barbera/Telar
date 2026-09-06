/**
 * The workspace listing and the file read.
 *
 * The git half is pinned against the exact argv the reader sends, because the
 * flags ARE the feature: drop `--exclude-standard` and the Files tree becomes
 * 40,000 rows of `node_modules`, drop `--deduplicate` and every staged-and-
 * modified file appears twice, drop `-z` and a filename with a newline in it
 * splits into two rows that both point nowhere.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { listWorkspaceFilesAsync, readWorkspaceFileAsync, walkWorkspaceFilesAsync, contentHash, listWorkspaceFiles, MAX_WORKSPACE_FILES, readWorkspaceFile, walkWorkspaceFiles, writeWorkspaceFile } from "../src/files";
import type { GitResult, GitRunner } from "../src/worktree";

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

function runner(replies: Record<string, GitResult>, seen?: string[][]): GitRunner {
  return (_cwd, args) => {
    seen?.push(args);
    return replies[args.slice(0, 2).join(" ")] ?? fail();
  };
}

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "telar-files-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("listWorkspaceFiles, in a repository", () => {
  test("asks git for tracked and unignored-untracked files, NUL-delimited and deduplicated", () => {
    const seen: string[][] = [];
    const listing = listWorkspaceFiles(
      runner(
        {
          "rev-parse --is-inside-work-tree": ok("true\n"),
          "ls-files --cached": ok("apps/engine/src/files.ts\0README.md\0"),
        },
        seen,
      ),
      { cwd: "/repo", now: 1_000 },
    );
    expect(listing).toEqual({
      workspacePath: "/repo",
      repository: true,
      // Sorted, so the tree's order does not depend on which reader answered.
      files: ["README.md", "apps/engine/src/files.ts"],
      source: "git",
      truncated: false,
      readAt: 1_000,
    });
    // The flags, verbatim. Every one of them is load-bearing — see the header.
    expect(seen.at(-1)).toEqual(["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]);
  });

  test("a filename containing a newline stays one path", () => {
    // The reason for `-z`. A line-based reader turns this into two dead rows.
    const listing = listWorkspaceFiles(
      runner({
        "rev-parse --is-inside-work-tree": ok("true\n"),
        "ls-files --cached": ok("weird\nname.txt\0plain.txt\0"),
      }),
      { cwd: "/repo", now: 1 },
    );
    expect(listing.files).toEqual(["plain.txt", "weird\nname.txt"]);
  });

  test("git failing inside a repository is an empty list, not a walk", () => {
    // Falling back to a walk here would quietly ignore `.gitignore` and answer a
    // question nobody asked, with 40,000 rows.
    const listing = listWorkspaceFiles(runner({ "rev-parse --is-inside-work-tree": ok("true\n") }), { cwd: "/repo", now: 1 });
    expect(listing).toMatchObject({ repository: true, source: "git", files: [] });
  });

  test("the list is capped, and says so", () => {
    const many = Array.from({ length: MAX_WORKSPACE_FILES + 10 }, (_unused, index) => `f${String(index).padStart(6, "0")}.ts`);
    const listing = listWorkspaceFiles(
      runner({
        "rev-parse --is-inside-work-tree": ok("true\n"),
        "ls-files --cached": ok(`${many.join("\0")}\0`),
      }),
      { cwd: "/repo", now: 1 },
    );
    expect(listing.files).toHaveLength(MAX_WORKSPACE_FILES);
    expect(listing.truncated).toBe(true);
  });
});

describe("listWorkspaceFiles, in a plain directory", () => {
  test("walks it and reports that it walked", () => {
    // `envMode: "local"` supports an unversioned directory on purpose, so this
    // is a supported configuration and not a failure.
    const root = scratch();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/app.ts"), "export {};\n");
    writeFileSync(path.join(root, "notes.md"), "# hi\n");
    const listing = listWorkspaceFiles(runner({}), { cwd: root, now: 7 });
    expect(listing).toMatchObject({ repository: false, source: "walk", truncated: false, readAt: 7 });
    expect(listing.files).toEqual(["notes.md", "src/app.ts"]);
  });
});

describe("walkWorkspaceFiles", () => {
  test("skips the caches nobody reads source out of, and every dotted directory", () => {
    const root = scratch();
    for (const dir of ["node_modules", "dist", ".git", "src"]) mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, "node_modules/dep.js"), "");
    writeFileSync(path.join(root, "dist/bundle.js"), "");
    writeFileSync(path.join(root, ".git/config"), "");
    writeFileSync(path.join(root, "src/real.ts"), "");
    // A dotted FILE is still listed — `.gitignore` and `.env.example` are files
    // people open. Only dotted DIRECTORIES are skipped.
    writeFileSync(path.join(root, ".gitignore"), "");
    expect(walkWorkspaceFiles(root)).toEqual([".gitignore", "src/real.ts"]);
  });

  test("does not follow a symlink into its own parent", () => {
    // Without this the walk is a cycle and the daemon hangs. `isFile()` is false
    // for a link, which is what stops it.
    const root = scratch();
    mkdirSync(path.join(root, "inner"));
    writeFileSync(path.join(root, "inner/a.ts"), "");
    symlinkSync(root, path.join(root, "inner/loop"), "dir");
    expect(walkWorkspaceFiles(root)).toEqual(["inner/a.ts"]);
  });

  test("breadth-first, so a cap loses the deepest paths rather than a whole subtree", () => {
    // Depth-first with a cap would return `a/**` and make the repository look
    // like it has no `z` at all.
    const root = scratch();
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "a/deep"));
    writeFileSync(path.join(root, "a/one.ts"), "");
    writeFileSync(path.join(root, "a/deep/two.ts"), "");
    writeFileSync(path.join(root, "z.ts"), "");
    expect(walkWorkspaceFiles(root, 2)).toEqual(["z.ts", "a/one.ts"]);
  });
});

describe("readWorkspaceFile", () => {
  test("reads text, with the real size and the hash a write will need", () => {
    const root = scratch();
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(readWorkspaceFile({ cwd: root, path: "a.ts" })).toEqual({
      path: "a.ts",
      text: "export const a = 1;\n",
      bytes: 20,
      sha256: contentHash(Buffer.from("export const a = 1;\n")),
      binary: false,
      truncated: false,
    });
  });

  test("the hash is of the WHOLE file even when the text is cut", () => {
    // The hash is a write precondition. Computed over the prefix a reader got, it
    // would authorise a save that discards everything after the cut.
    const root = scratch();
    writeFileSync(path.join(root, "big.ts"), "x".repeat(50));
    const file = readWorkspaceFile({ cwd: root, path: "big.ts", maxBytes: 10 });
    expect(file.truncated).toBe(true);
    expect(file.sha256).toBe(contentHash(Buffer.from("x".repeat(50))));
    expect(file.sha256).not.toBe(contentHash(Buffer.from("x".repeat(10))));
  });

  test("a NUL byte means binary, and no bytes are sent", () => {
    // The same test `git diff` uses. Sniffing extensions would call a `.txt`
    // full of bytes text and render line noise.
    const root = scratch();
    writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(readWorkspaceFile({ cwd: root, path: "logo.png" })).toMatchObject({ text: "", binary: true, bytes: 6 });
  });

  test("a long file arrives cut, flagged, and still reports its real size", () => {
    // The flag is the point: a viewer handed half a file with no flag shows a
    // syntax error that is not in the source.
    const root = scratch();
    writeFileSync(path.join(root, "big.ts"), "x".repeat(50));
    const file = readWorkspaceFile({ cwd: root, path: "big.ts", maxBytes: 10 });
    expect(file).toEqual({
      path: "big.ts",
      text: "xxxxxxxxxx",
      bytes: 50,
      sha256: contentHash(Buffer.from("x".repeat(50))),
      binary: false,
      truncated: true,
    });
  });
});

describe("writeWorkspaceFile", () => {
  const seed = (text: string) => {
    const root = scratch();
    writeFileSync(path.join(root, "a.ts"), text);
    return { root, sha256: contentHash(Buffer.from(text)) };
  };

  test("replaces the file and answers with the new hash", () => {
    const { root, sha256 } = seed("const a = 1;\n");
    const result = writeWorkspaceFile({ cwd: root, path: "a.ts", text: "const a = 2;\n", expected: sha256 });
    expect(result.written).toBe(true);
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
    // The answer's hash is of what was just written, so an editor can keep saving
    // without re-reading — otherwise the second keystroke conflicts with itself.
    if (result.written) expect(result.file.sha256).toBe(contentHash(Buffer.from("const a = 2;\n")));
  });

  test("REFUSES when disk moved under the editor", () => {
    // The case the whole precondition exists for: an agent wrote the file while a
    // person had it open. Last-write-wins here is a data-loss button.
    const { root } = seed("const a = 1;\n");
    writeFileSync(path.join(root, "a.ts"), "written by the agent\n");
    const result = writeWorkspaceFile({
      cwd: root,
      path: "a.ts",
      text: "written by the human\n",
      expected: contentHash(Buffer.from("const a = 1;\n")),
    });
    expect(result).toMatchObject({ written: false, refusal: "conflict" });
    // Untouched, and the CURRENT hash comes back so the editor can re-read
    // without a second round trip.
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("written by the agent\n");
    if (!result.written) expect(result.sha256).toBe(contentHash(Buffer.from("written by the agent\n")));
  });

  test("refuses to save a prefix over a file that was read truncated", () => {
    // Enforced at the engine as well as hidden in the client: one client's bug
    // must not be able to truncate a file.
    const { root, sha256 } = seed("y".repeat(50));
    const result = writeWorkspaceFile({ cwd: root, path: "a.ts", text: "y".repeat(10), expected: sha256, maxBytes: 10 });
    expect(result).toMatchObject({ written: false, refusal: "too_large" });
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toHaveLength(50);
  });

  test("refuses a binary file and a file that is not there", () => {
    const root = scratch();
    writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(writeWorkspaceFile({ cwd: root, path: "logo.png", text: "text", expected: "whatever" })).toMatchObject({
      written: false,
      refusal: "binary",
    });
    // This endpoint REPLACES; it does not create. `expected` has no meaning for a
    // file that does not exist yet.
    expect(writeWorkspaceFile({ cwd: root, path: "new.ts", text: "text", expected: "whatever" })).toMatchObject({
      written: false,
      refusal: "not_found",
    });
  });

  test("leaves no scratch file behind", () => {
    // The write is atomic — written beside the target and renamed over it — and a
    // leftover temp file would show up in the tree, in `git status`, and in the
    // next person's diff.
    const { root, sha256 } = seed("const a = 1;\n");
    writeWorkspaceFile({ cwd: root, path: "a.ts", text: "const a = 3;\n", expected: sha256 });
    expect(readdirSync(root)).toEqual(["a.ts"]);
  });
});


test("async Files listing stays responsive during Git and preserves repository results", async () => {
  let release!: (value: GitResult) => void;
  let ticks = false;
  const ready = new Promise<GitResult>(resolve => { release = resolve; });
  const listing = listWorkspaceFilesAsync(async (_cwd, args) => args[0] === "rev-parse" ? ready : ok("a.ts\0two\nlines.txt\0"), { cwd: "/repo", now: 1 });
  setTimeout(() => { ticks = true; release(ok("true\n")); }, 10);
  const result = await listing;
  expect(ticks).toBe(true);
  expect(result).toEqual({ workspacePath: "/repo", repository: true, source: "git", files: ["a.ts", "two\nlines.txt"], truncated: false, readAt: 1 });
});

test("async unversioned walk preserves exclusions and refuses symlink traversal", async () => {
  const root = scratch();
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, "src", "index.ts"), "hello");
  writeFileSync(path.join(root, "node_modules", "dependency.js"), "ignored");
  symlinkSync(root, path.join(root, "src", "cycle"));
  expect((await walkWorkspaceFilesAsync(root)).sort()).toEqual(walkWorkspaceFiles(root).sort());
  expect(await listWorkspaceFilesAsync(async () => fail(), { cwd: root, now: 2 }))
    .toEqual(listWorkspaceFiles(() => fail(), { cwd: root, now: 2 }));
  await expect(listWorkspaceFilesAsync(async () => ({ status: 124, stdout: "", stderr: "timed out", timedOut: true }), { cwd: root, now: 2 })).rejects.toThrow("timed out");
});

test("async file preview hashes the whole file while retaining text and binary semantics", async () => {
  const root = scratch();
  const text = Buffer.alloc(2 * 1024 * 1024, "x");
  writeFileSync(path.join(root, "large.txt"), text);
  writeFileSync(path.join(root, "binary.dat"), Buffer.from([65, 0, 66]));
  writeFileSync(path.join(root, "empty.txt"), "");
  for (const file of ["large.txt", "binary.dat", "empty.txt"]) {
    const input = { cwd: root, path: file, maxBytes: 17 };
    expect(await readWorkspaceFileAsync(input)).toEqual(readWorkspaceFile(input));
  }
  const preview = await readWorkspaceFileAsync({ cwd: root, path: "large.txt", maxBytes: 17 });
  expect(preview.sha256).toBe(contentHash(text));
  expect(preview.text).toHaveLength(17);
  await expect(readWorkspaceFileAsync({ cwd: root, path: "missing" })).rejects.toThrow();
});
