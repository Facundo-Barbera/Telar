/**
 * The workspace listing and the file read.
 *
 * The git half is pinned against the exact argv the reader sends, because the
 * flags ARE the feature: drop `--exclude-standard` and the Files tree becomes
 * 40,000 rows of `node_modules`, drop `--deduplicate` and every staged-and-
 * modified file appears twice, drop `-z` and a filename with a newline in it
 * splits into two rows that both point nowhere.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { listWorkspaceFiles, MAX_WORKSPACE_FILES, readWorkspaceFile, walkWorkspaceFiles } from "../src/files";
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
  test("reads text, with the real size", () => {
    const root = scratch();
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(readWorkspaceFile({ cwd: root, path: "a.ts" })).toEqual({
      path: "a.ts",
      text: "export const a = 1;\n",
      bytes: 20,
      binary: false,
      truncated: false,
    });
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
    expect(file).toEqual({ path: "big.ts", text: "xxxxxxxxxx", bytes: 50, binary: false, truncated: true });
  });
});
