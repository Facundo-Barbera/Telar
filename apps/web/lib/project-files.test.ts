// The `@` mention index — the RANKING that makes the menu usable, and the
// path validation that keeps a mention from naming a file outside the project.
//
// The second half is the one that matters: a mention arrives back over the wire
// on the next turn and is handed to a harness that will read it. A regression
// there hands the model a file the human never chose.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractMentions, resolveMention, searchProjectFiles } from "./project-files";

// A throwaway NON-git tree, so the walk fallback is what gets exercised. (The
// git path is the same function with a different candidate source; nothing
// below depends on which produced the list.)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-files-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "telar-outside-"));

beforeAll(() => {
  for (const rel of [
    "README.md",
    "app/api/chat/route.ts",
    "app/api/chats/route.ts",
    "docs/routing-notes.md",
    "node_modules/pkg/index.js",
  ]) {
    const full = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "shh");
});

describe("mention ranking", () => {
  test("a basename hit outranks a path hit", () => {
    // The reason the menu is worth having: "route" means route.ts, not the doc
    // that happens to have "routing" in its name.
    const hits = searchProjectFiles(ROOT, "route").map((f) => f.path);
    expect(hits[0]).toBe("app/api/chat/route.ts");
    expect(hits).toContain("docs/routing-notes.md");
    expect(hits.indexOf("app/api/chat/route.ts")).toBeLessThan(
      hits.indexOf("docs/routing-notes.md"),
    );
  });

  test("a subsequence still matches, and shallower paths win ties", () => {
    expect(searchProjectFiles(ROOT, "acr").map((f) => f.path)).toContain(
      "app/api/chat/route.ts",
    );
    // Empty query = the shallowest files, which is the best guess before the
    // human has typed anything to narrow by.
    expect(searchProjectFiles(ROOT, "")[0]?.path).toBe("README.md");
  });

  test("the walk skips node_modules", () => {
    expect(searchProjectFiles(ROOT, "index").map((f) => f.path)).not.toContain(
      "node_modules/pkg/index.js",
    );
  });
});

describe("mention resolution refuses to leave the project", () => {
  test("a legitimate repo-relative path resolves", () => {
    expect(resolveMention(ROOT, "app/api/chat/route.ts")).toBe(
      path.join(ROOT, "app/api/chat/route.ts"),
    );
  });

  test("traversal, absolute paths and directories are all refused", () => {
    expect(resolveMention(ROOT, "../../etc/passwd")).toBeNull();
    expect(resolveMention(ROOT, path.join(OUTSIDE, "secret.txt"))).toBeNull();
    // A directory is not a mention — `mention` names a file on both harnesses.
    expect(resolveMention(ROOT, "app/api")).toBeNull();
    expect(resolveMention(ROOT, "does/not/exist.ts")).toBeNull();
  });

  test("a sibling directory sharing the root's prefix is refused", () => {
    // The separator check: without it, "<root>-secrets" passes a bare
    // startsWith("<root>") test and escapes the project one character early.
    const sibling = `${ROOT}-secrets`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "keys.txt"), "shh");
    expect(resolveMention(ROOT, `../${path.basename(sibling)}/keys.txt`)).toBeNull();
  });
});

describe("mentions are read back out of the message text", () => {
  test("only tokens that resolve to a real file become mentions", () => {
    const text = "compare @app/api/chat/route.ts with @app/api/nope.ts please";
    expect(extractMentions(text, ROOT)).toEqual([
      { name: "route.ts", path: "app/api/chat/route.ts" },
    ]);
  });

  test("ordinary prose is not mangled into mentions", () => {
    // A package name, an email, and a mid-word @ — none are candidates, and
    // none exist as files anyway. Both guards are worth having: the anchor stops
    // the email, existence stops the package.
    const text = "@telar/core is a package, mail bix@example.com, see foo@bar";
    expect(extractMentions(text, ROOT)).toEqual([]);
  });

  test("trailing sentence punctuation is not part of the path", () => {
    expect(extractMentions("look at @README.md.", ROOT)).toEqual([
      { name: "README.md", path: "README.md" },
    ]);
  });

  test("the same file mentioned twice is carried once", () => {
    expect(extractMentions("@README.md and again @README.md", ROOT)).toHaveLength(1);
  });
});
