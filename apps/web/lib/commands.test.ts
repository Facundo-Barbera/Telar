// @ts-expect-error no @types/bun in this workspace
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjectCommands } from "./commands";

let dirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-commands-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function write(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("listProjectCommands", () => {
  test("missing .claude/commands dir returns []", () => {
    const root = tmpProject();
    expect(listProjectCommands(root)).toEqual([]);
  });

  test("flat command with frontmatter description", () => {
    const root = tmpProject();
    write(
      root,
      ".claude/commands/review.md",
      "---\ndescription: Review the diff\n---\nBody text.\n",
    );
    expect(listProjectCommands(root)).toEqual([
      { name: "review", description: "Review the diff" },
    ]);
  });

  test("command with no frontmatter gets an empty description", () => {
    const root = tmpProject();
    write(root, ".claude/commands/plain.md", "Just body, no frontmatter.\n");
    expect(listProjectCommands(root)).toEqual([{ name: "plain", description: "" }]);
  });

  test("nested commands are namespaced with ':' and sorted", () => {
    const root = tmpProject();
    write(root, ".claude/commands/git/commit.md", "---\ndescription: Commit\n---\n");
    write(root, ".claude/commands/git/push.md", "---\ndescription: Push\n---\n");
    write(root, ".claude/commands/top.md", "---\ndescription: Top level\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "git:commit", description: "Commit" },
      { name: "git:push", description: "Push" },
      { name: "top", description: "Top level" },
    ]);
  });

  test("non-.md files are ignored", () => {
    const root = tmpProject();
    write(root, ".claude/commands/readme.txt", "not a command");
    write(root, ".claude/commands/real.md", "---\ndescription: Real\n---\n");
    expect(listProjectCommands(root)).toEqual([{ name: "real", description: "Real" }]);
  });

  test("malformed YAML frontmatter degrades to empty description, not a throw", () => {
    const root = tmpProject();
    write(root, ".claude/commands/bad.md", "---\ndescription: [unterminated\n---\nBody\n");
    expect(listProjectCommands(root)).toEqual([{ name: "bad", description: "" }]);
  });

  test("a '---' later in the body is not mistaken for frontmatter", () => {
    const root = tmpProject();
    write(root, ".claude/commands/rule.md", "No leading frontmatter.\n---\nHorizontal rule below.\n");
    expect(listProjectCommands(root)).toEqual([{ name: "rule", description: "" }]);
  });

  test("a symlink escaping .claude/commands is not followed", () => {
    const root = tmpProject();
    const outside = tmpProject();
    write(outside, "secret.md", "---\ndescription: Should not be listed\n---\n");
    fs.mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(root, ".claude", "commands", "leaked.md"),
    );
    expect(listProjectCommands(root)).toEqual([]);
  });
});
