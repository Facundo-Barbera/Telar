import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { contentHash, listWorkspaceFilesAsync, MAX_WORKSPACE_FILES, mediaTypeFor, readWorkspaceFile, readWorkspaceFileAsync, readWorkspaceFileBytes, walkWorkspaceFilesAsync, writeWorkspaceFile } from "./workspace";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";

const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (): GitResult => ({ status: 1, stdout: "", stderr: "fatal" });

function runner(replies: Record<string, GitResult>, seen?: string[][]): AsyncGitRunner {
  return async (_cwd, args) => {
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

describe("listWorkspaceFilesAsync, in a repository", () => {
  test("asks git for tracked and unignored-untracked files, NUL-delimited and deduplicated", async () => {
    const seen: string[][] = [];
    const listing = await listWorkspaceFilesAsync(
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
      files: ["README.md", "apps/engine/src/files.ts"],
      source: "git",
      truncated: false,
      readAt: 1_000,
    });
    expect(seen.at(-1)).toEqual(["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]);
  });

  test("a filename containing a newline stays one path", async () => {
    const listing = await listWorkspaceFilesAsync(
      runner({
        "rev-parse --is-inside-work-tree": ok("true\n"),
        "ls-files --cached": ok("weird\nname.txt\0plain.txt\0"),
      }),
      { cwd: "/repo", now: 1 },
    );
    expect(listing.files).toEqual(["plain.txt", "weird\nname.txt"]);
  });

  test("git failing inside a repository is an empty list, not a walk", async () => {
    const listing = await listWorkspaceFilesAsync(runner({ "rev-parse --is-inside-work-tree": ok("true\n") }), { cwd: "/repo", now: 1 });
    expect(listing).toMatchObject({ repository: true, source: "git", files: [] });
  });

  test("the list is capped, and says so", async () => {
    const many = Array.from({ length: MAX_WORKSPACE_FILES + 10 }, (_unused, index) => `f${String(index).padStart(6, "0")}.ts`);
    const listing = await listWorkspaceFilesAsync(
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

describe("listWorkspaceFilesAsync, in a plain directory", () => {
  test("walks it and reports that it walked", async () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/app.ts"), "export {};\n");
    writeFileSync(path.join(root, "notes.md"), "# hi\n");
    const listing = await listWorkspaceFilesAsync(runner({}), { cwd: root, now: 7 });
    expect(listing).toMatchObject({ repository: false, source: "walk", truncated: false, readAt: 7 });
    expect(listing.files).toEqual(["notes.md", "src/app.ts"]);
  });
});

describe("walkWorkspaceFilesAsync", () => {
  test("skips the caches nobody reads source out of, and every dotted directory", async () => {
    const root = scratch();
    for (const dir of ["node_modules", "dist", ".git", "src"]) mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, "node_modules/dep.js"), "");
    writeFileSync(path.join(root, "dist/bundle.js"), "");
    writeFileSync(path.join(root, ".git/config"), "");
    writeFileSync(path.join(root, "src/real.ts"), "");
    writeFileSync(path.join(root, ".gitignore"), "");
    expect(await walkWorkspaceFilesAsync(root)).toEqual([".gitignore", "src/real.ts"]);
  });

  test("does not follow a symlink into its own parent", async () => {
    const root = scratch();
    mkdirSync(path.join(root, "inner"));
    writeFileSync(path.join(root, "inner/a.ts"), "");
    symlinkSync(root, path.join(root, "inner/loop"), "dir");
    expect(await walkWorkspaceFilesAsync(root)).toEqual(["inner/a.ts"]);
  });

  test("breadth-first, so a cap loses the deepest paths rather than a whole subtree", async () => {
    const root = scratch();
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "a/deep"));
    writeFileSync(path.join(root, "a/one.ts"), "");
    writeFileSync(path.join(root, "a/deep/two.ts"), "");
    writeFileSync(path.join(root, "z.ts"), "");
    expect(await walkWorkspaceFilesAsync(root, 2)).toEqual(["z.ts", "a/one.ts"]);
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
    const root = scratch();
    writeFileSync(path.join(root, "big.ts"), "x".repeat(50));
    const file = readWorkspaceFile({ cwd: root, path: "big.ts", maxBytes: 10 });
    expect(file.truncated).toBe(true);
    expect(file.sha256).toBe(contentHash(Buffer.from("x".repeat(50))));
    expect(file.sha256).not.toBe(contentHash(Buffer.from("x".repeat(10))));
  });

  test("a NUL byte means binary, and no bytes are sent", () => {
    const root = scratch();
    writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(readWorkspaceFile({ cwd: root, path: "logo.png" })).toMatchObject({ text: "", binary: true, bytes: 6 });
  });

  test("a long file arrives cut, flagged, and still reports its real size", () => {
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
    if (result.written) expect(result.file.sha256).toBe(contentHash(Buffer.from("const a = 2;\n")));
  });

  test("REFUSES when disk moved under the editor", () => {
    const { root } = seed("const a = 1;\n");
    writeFileSync(path.join(root, "a.ts"), "written by the agent\n");
    const result = writeWorkspaceFile({
      cwd: root,
      path: "a.ts",
      text: "written by the human\n",
      expected: contentHash(Buffer.from("const a = 1;\n")),
    });
    expect(result).toMatchObject({ written: false, refusal: "conflict" });
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("written by the agent\n");
    if (!result.written) expect(result.sha256).toBe(contentHash(Buffer.from("written by the agent\n")));
  });

  test("refuses to save a prefix over a file that was read truncated", () => {
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
    expect(writeWorkspaceFile({ cwd: root, path: "new.ts", text: "text", expected: "whatever" })).toMatchObject({
      written: false,
      refusal: "not_found",
    });
  });

  test("leaves no scratch file behind", () => {
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
  setImmediate(() => { ticks = true; release(ok("true\n")); });
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
  expect(await walkWorkspaceFilesAsync(root)).toEqual(["src/index.ts"]);
  expect(await listWorkspaceFilesAsync(async () => fail(), { cwd: root, now: 2 })).toMatchObject({ repository: false, source: "walk", files: ["src/index.ts"] });
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

describe("the raw bytes read (the media viewers' route)", () => {
  test("serves a binary file whole, with the media type its name declares", async () => {
    const root = scratch();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    writeFileSync(path.join(root, "plot.png"), bytes);
    const raw = await readWorkspaceFileBytes({ cwd: root, path: "plot.png" });
    expect(raw.mediaType).toBe("image/png");
    expect(raw.bytes).toBe(bytes.length);
    expect(Buffer.compare(raw.data, bytes)).toBe(0);
  });

  test("refuses past the ceiling instead of truncating — half a PDF is not a smaller PDF", async () => {
    const root = scratch();
    writeFileSync(path.join(root, "big.pdf"), Buffer.alloc(32));
    await expect(readWorkspaceFileBytes({ cwd: root, path: "big.pdf", maxBytes: 16 })).rejects.toThrow(/larger than/);
  });

  test("the media-type table answers by extension and falls back to opaque bytes", () => {
    expect(mediaTypeFor("docs/guide.pdf")).toBe("application/pdf");
    expect(mediaTypeFor("a/b/movie.MOV")).toBe("video/quicktime");
    expect(mediaTypeFor("notes.md")).toContain("text/markdown");
    expect(mediaTypeFor("mystery.bin")).toBe("application/octet-stream");
    expect(mediaTypeFor(".gitignore")).toBe("application/octet-stream");
  });
});
