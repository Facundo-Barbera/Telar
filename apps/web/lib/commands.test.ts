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
      { name: "review", description: "Review the diff", kind: "command" },
    ]);
  });

  test("command with no frontmatter gets an empty description", () => {
    const root = tmpProject();
    write(root, ".claude/commands/plain.md", "Just body, no frontmatter.\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "plain", description: "", kind: "command" },
    ]);
  });

  test("nested commands are namespaced with ':' and sorted", () => {
    const root = tmpProject();
    write(root, ".claude/commands/git/commit.md", "---\ndescription: Commit\n---\n");
    write(root, ".claude/commands/git/push.md", "---\ndescription: Push\n---\n");
    write(root, ".claude/commands/top.md", "---\ndescription: Top level\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "git:commit", description: "Commit", kind: "command" },
      { name: "git:push", description: "Push", kind: "command" },
      { name: "top", description: "Top level", kind: "command" },
    ]);
  });

  test("non-.md files are ignored", () => {
    const root = tmpProject();
    write(root, ".claude/commands/readme.txt", "not a command");
    write(root, ".claude/commands/real.md", "---\ndescription: Real\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "real", description: "Real", kind: "command" },
    ]);
  });

  test("malformed YAML frontmatter degrades to empty description, not a throw", () => {
    const root = tmpProject();
    write(root, ".claude/commands/bad.md", "---\ndescription: [unterminated\n---\nBody\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "bad", description: "", kind: "command" },
    ]);
  });

  test("a '---' later in the body is not mistaken for frontmatter", () => {
    const root = tmpProject();
    write(root, ".claude/commands/rule.md", "No leading frontmatter.\n---\nHorizontal rule below.\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "rule", description: "", kind: "command" },
    ]);
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

  test("missing .claude/skills dir contributes nothing", () => {
    const root = tmpProject();
    write(root, ".claude/commands/only.md", "---\ndescription: Only\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "only", description: "Only", kind: "command" },
    ]);
  });

  test("skill: frontmatter name overrides the directory name", () => {
    const root = tmpProject();
    write(
      root,
      ".claude/skills/dir-name/SKILL.md",
      "---\nname: real-name\ndescription: A skill\n---\nBody.\n",
    );
    expect(listProjectCommands(root)).toEqual([
      { name: "real-name", description: "A skill", kind: "skill" },
    ]);
  });

  test("skill: missing frontmatter name falls back to the directory name", () => {
    const root = tmpProject();
    write(root, ".claude/skills/bmad-prd/SKILL.md", "---\ndescription: A skill\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "bmad-prd", description: "A skill", kind: "skill" },
    ]);
  });

  test("skill: missing description defaults to empty", () => {
    const root = tmpProject();
    write(root, ".claude/skills/no-desc/SKILL.md", "---\nname: no-desc\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "no-desc", description: "", kind: "skill" },
    ]);
  });

  test("skill: single-quoted multi-line YAML description parses fully", () => {
    const root = tmpProject();
    write(
      root,
      ".claude/skills/multiline/SKILL.md",
      [
        "---",
        "name: multiline",
        "description: 'First sentence about the skill. Second sentence",
        "  wraps onto another line. Third sentence too.'",
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(listProjectCommands(root)).toEqual([
      {
        name: "multiline",
        description:
          "First sentence about the skill. Second sentence wraps onto another line. Third sentence too.",
        kind: "skill",
      },
    ]);
  });

  test("skill: a directory without SKILL.md is not listed (empty dir)", () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".claude", "skills", "empty"), { recursive: true });
    write(root, ".claude/skills/real/SKILL.md", "---\ndescription: Real skill\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "real", description: "Real skill", kind: "skill" },
    ]);
  });

  test("commands sort before skills, alphabetical within each group", () => {
    const root = tmpProject();
    write(root, ".claude/commands/zzz.md", "---\ndescription: Z command\n---\n");
    write(root, ".claude/commands/aaa.md", "---\ndescription: A command\n---\n");
    write(root, ".claude/skills/zzz-skill/SKILL.md", "---\ndescription: Z skill\n---\n");
    write(root, ".claude/skills/aaa-skill/SKILL.md", "---\ndescription: A skill\n---\n");
    expect(listProjectCommands(root)).toEqual([
      { name: "aaa", description: "A command", kind: "command" },
      { name: "zzz", description: "Z command", kind: "command" },
      { name: "aaa-skill", description: "A skill", kind: "skill" },
      { name: "zzz-skill", description: "Z skill", kind: "skill" },
    ]);
  });

  test("a symlink escaping .claude/skills is not followed", () => {
    const root = tmpProject();
    const outside = tmpProject();
    fs.mkdirSync(path.join(outside, "secret-skill"), { recursive: true });
    write(outside, "secret-skill/SKILL.md", "---\ndescription: Should not be listed\n---\n");
    fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "secret-skill"),
      path.join(root, ".claude", "skills", "leaked"),
    );
    expect(listProjectCommands(root)).toEqual([]);
  });
});
