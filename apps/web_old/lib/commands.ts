import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

// Claude Code slash-command / skill frontmatter: an optional YAML block
// delimited by "---" at the very top of the file. `^` (no /m) anchors to file
// start only — a "---" later in the body (e.g. a markdown rule) must not match.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// Parses the leading YAML frontmatter block, if any, into a plain object.
// Descriptions (and skill names) may be single-quoted multi-sentence/
// multi-line YAML scalars — the `yaml` package handles that natively, so
// there's no bespoke parsing here beyond picking the fields back out.
function frontmatterOf(raw: string): Record<string, unknown> {
  const m = raw.match(FRONTMATTER);
  if (!m) return {};
  try {
    const fm = YAML.parse(m[1]);
    return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {};
  } catch {
    return {}; // malformed frontmatter — still list the entry, just undescribed
  }
}

function descriptionOf(raw: string): string {
  const fm = frontmatterOf(raw);
  return typeof fm.description === "string" ? fm.description : "";
}

// Resolves a path to its realpath, falling back to a plain resolve when the
// path doesn't exist yet — used only for the projectRoot boundary check,
// which must still produce a comparable absolute path even if the root
// itself is missing/unreadable.
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Recursively scans <projectRoot>/.claude/commands for *.md files, Claude
// Code-style: name = path relative to the commands dir minus ".md", with
// path separators replaced by ":" (namespacing e.g. "git:commit").
//
// SECURITY: every path we read is realpath-resolved and re-checked against
// `base` (the resolved commands dir) before it's followed or opened, so a
// symlink planted inside .claude/commands — or the commands dir itself being
// a symlink — can never walk reads outside that directory. There is no
// user-controlled path input here; the only argument is the project's own
// root from the (server-trusted) manifest.
function scanCommands(projectRoot: string): ProjectCommand[] {
  const commandsDir = path.join(projectRoot, ".claude", "commands");
  let base: string;
  try {
    base = fs.realpathSync(commandsDir);
  } catch {
    return []; // missing commands dir — not an error, just nothing to list
  }
  const projectRootReal = realpathOrResolve(projectRoot);
  if (base !== projectRootReal && !base.startsWith(projectRootReal + path.sep)) {
    return []; // .claude/commands itself escapes projectRoot via a symlink
  }

  const out: ProjectCommand[] = [];
  const walk = (dir: string, relSegments: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      let real: string;
      try {
        real = fs.realpathSync(abs);
      } catch {
        continue; // broken symlink or race — skip
      }
      if (real !== base && !real.startsWith(base + path.sep)) continue; // escapes the commands dir

      let stat: fs.Stats;
      try {
        stat = fs.statSync(real);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, [...relSegments, entry.name]);
      } else if (stat.isFile() && entry.name.endsWith(".md")) {
        const stem = entry.name.slice(0, -3);
        const name = [...relSegments, stem].join(":");
        let raw = "";
        try {
          raw = fs.readFileSync(real, "utf8");
        } catch {
          continue;
        }
        out.push({ name, description: descriptionOf(raw), kind: "command" });
      }
    }
  };
  walk(commandsDir, []);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Scans <projectRoot>/.claude/skills/*/SKILL.md — one directory level, unlike
// commands: each skill is exactly one directory containing a SKILL.md file
// (no further nesting/namespacing). name = frontmatter "name" ?? the
// directory name; description = frontmatter "description" ?? "".
//
// Repo skills are slash commands as far as the Claude Agent SDK is concerned
// (typing "/skill-name" invokes one, and the SDK's init message lists them in
// slash_commands right alongside .claude/commands entries) — this is why
// telar's menu needs to know about them at all.
//
// SECURITY: same stance as scanCommands — every path is realpath-resolved and
// re-checked against `base` (the resolved skills dir) before being followed
// or read, so a symlinked skill dir/file can't walk reads outside .claude/skills.
function scanSkills(projectRoot: string): ProjectCommand[] {
  const skillsDir = path.join(projectRoot, ".claude", "skills");
  let base: string;
  try {
    base = fs.realpathSync(skillsDir);
  } catch {
    return []; // missing skills dir — not an error, just nothing to list
  }
  const projectRootReal = realpathOrResolve(projectRoot);
  if (base !== projectRootReal && !base.startsWith(projectRootReal + path.sep)) {
    return []; // .claude/skills itself escapes projectRoot via a symlink
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ProjectCommand[] = [];
  for (const entry of entries) {
    const dirAbs = path.join(base, entry.name);
    let dirReal: string;
    try {
      dirReal = fs.realpathSync(dirAbs);
    } catch {
      continue; // broken symlink or race — skip
    }
    if (dirReal !== base && !dirReal.startsWith(base + path.sep)) continue; // escapes the skills dir

    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(dirReal);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue; // a skill is a directory; stray files at this level are ignored

    const skillFile = path.join(dirReal, "SKILL.md");
    let fileReal: string;
    try {
      fileReal = fs.realpathSync(skillFile);
    } catch {
      continue; // no SKILL.md in this dir — not a skill (also covers "empty dir")
    }
    if (fileReal !== base && !fileReal.startsWith(base + path.sep)) continue; // escapes the skills dir

    let raw: string;
    try {
      raw = fs.readFileSync(fileReal, "utf8");
    } catch {
      continue;
    }
    const fm = frontmatterOf(raw);
    const name = typeof fm.name === "string" && fm.name.trim() ? fm.name : entry.name;
    const description = typeof fm.description === "string" ? fm.description : "";
    out.push({ name, description, kind: "skill" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Combined entry point the API route calls: .claude/commands entries, then
// .claude/skills entries. Each half is already sorted alphabetically on its
// own, so concatenation alone gives the required "commands first, then
// skills, alphabetical within each" order.
export function listProjectCommands(projectRoot: string): ProjectCommand[] {
  return [...scanCommands(projectRoot), ...scanSkills(projectRoot)];
}
