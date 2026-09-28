import { describe, expect, test } from "bun:test";
import { porcelainPaths } from "../../platform/git/parse";
import { type GhResult, type GhRunner } from "./gh";
import { commentOnPullLine, hunkRanges, lineCommentArgv, readPullFiles, readPullForBranch } from "./pulls";

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): GhResult => ({ status, stdout: "", stderr });
const SHA = "a".repeat(40);

function recording(reply: GhResult, seen: string[][]): GhRunner {
  return async (_cwd, args) => {
    seen.push(args);
    return reply;
  };
}

const LINE = { commitId: SHA, path: "src/a.ts", line: 12, side: "RIGHT" as const, body: "Why?" };

describe("placing a line on a pull request (#1014)", () => {
  test("every value is a field, never part of the path or a query", () => {
    const argv = lineCommentArgv(7, { ...LINE, body: "@/etc/passwd } {", path: "@x", startLine: 10, startSide: "LEFT" });
    expect(argv).toContain("repos/{owner}/{repo}/pulls/7/comments");
    for (const field of ["body=@/etc/passwd } {", "path=@x", `commit_id=${SHA}`, "side=RIGHT", "start_side=LEFT"]) {
      expect(argv[argv.indexOf(field) - 1]).toBe("-f");
    }
    expect(argv[argv.indexOf("line=12") - 1]).toBe("-F");
    expect(argv[argv.indexOf("start_line=10") - 1]).toBe("-F");
    expect(argv.some((arg) => arg.startsWith("query="))).toBe(false);
  });

  test("a single line sends no range fields", () => {
    expect(lineCommentArgv(7, LINE).some((arg) => arg.startsWith("start_"))).toBe(false);
  });

  test("an empty comment is refused before GitHub is asked", async () => {
    const seen: string[][] = [];
    expect(await commentOnPullLine(recording(ok("{}"), seen), "/repo", 7, { ...LINE, body: "  " })).toMatchObject({
      commented: false,
      refusal: "invalid_body",
    });
    expect(seen).toHaveLength(0);
  });

  test("a stored comment answers with its link, and the body is trimmed", async () => {
    const seen: string[][] = [];
    const result = await commentOnPullLine(recording(ok(JSON.stringify({ html_url: "https://github.com/o/r/pull/7#discussion_r1" })), seen), "/repo", 7, {
      ...LINE,
      body: " Why? ",
    });
    expect(result).toEqual({ commented: true, url: "https://github.com/o/r/pull/7#discussion_r1" });
    expect(seen[0]).toContain("body=Why?");
  });

  test("gh's missing-scope hint is refused as `scope`", async () => {
    const result = await commentOnPullLine(
      recording(failed('gh: This API operation needs the "repo" scope. To request it, run:  gh auth refresh -h github.com -s repo'), []),
      "/repo",
      7,
      LINE,
    );
    expect(result).toMatchObject({ commented: false, refusal: "scope" });
  });

  test("a line outside GitHub's diff keeps GitHub's own words", async () => {
    const result = await commentOnPullLine(
      recording(failed("gh: Validation Failed (HTTP 422)\npull_request_review_thread.line must be part of the diff"), []),
      "/repo",
      7,
      LINE,
    );
    expect(result).toMatchObject({ commented: false, refusal: "failed" });
  });

  test("the branch's open pull request is read with the branch as a value", async () => {
    const seen: string[][] = [];
    const pull = await readPullForBranch(
      recording(ok(JSON.stringify([{ number: 7, url: "https://github.com/o/r/pull/7", headRefOid: SHA, baseRefName: "main" }])), seen),
      "/repo",
      "telar/1014",
    );
    expect(pull).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", headRefOid: SHA, baseRefName: "main" });
    expect(seen[0]!.slice(0, 4)).toEqual(["pr", "list", "--head", "telar/1014"]);
    expect(await readPullForBranch(recording(ok("[]"), []), "/repo", "x")).toBeUndefined();
  });

  test("the pull request's files become hunk headers; a file without a patch has none", async () => {
    const rows = [JSON.stringify(["src/a.ts", "@@ -1,3 +1,4 @@\n a\n+b\n@@ -20 +21,2 @@ fn\n-x\n+y\n+z"]), JSON.stringify(["logo.png", ""])].join("\n");
    expect(await readPullFiles(recording(ok(rows), []), "/repo", 7)).toEqual([
      {
        path: "src/a.ts",
        hunks: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
          { oldStart: 20, oldLines: 1, newStart: 21, newLines: 2 },
        ],
      },
      { path: "logo.png", hunks: [] },
    ]);
  });

  test("hunkRanges reads a new file's header", () => {
    expect(hunkRanges("@@ -0,0 +1,2 @@\n+a\n+b")).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }]);
  });

  test("porcelainPaths counts both sides of a rename", () => {
    expect(porcelainPaths(" M src/a.ts\0R  new.ts\0old.ts\0?? tmp.txt\0")).toEqual(["src/a.ts", "new.ts", "old.ts", "tmp.txt"]);
  });
});
