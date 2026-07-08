import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type ProjectCommand = { name: string; description: string };

// Claude Code slash-command frontmatter: an optional YAML block delimited by
// "---" at the very top of the file. `^` (no /m) anchors to file start only —
// a "---" later in the body (e.g. a markdown rule) must not match.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function descriptionOf(raw: string): string {
  const m = raw.match(FRONTMATTER);
  if (!m) return "";
  try {
    const fm = YAML.parse(m[1]);
    return typeof fm?.description === "string" ? fm.description : "";
  } catch {
    return ""; // malformed frontmatter — still list the command, just undescribed
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
export function listProjectCommands(projectRoot: string): ProjectCommand[] {
  const commandsDir = path.join(projectRoot, ".claude", "commands");
  let base: string;
  try {
    base = fs.realpathSync(commandsDir);
  } catch {
    return []; // missing commands dir — not an error, just nothing to list
  }
  const projectRootReal = (() => {
    try {
      return fs.realpathSync(projectRoot);
    } catch {
      return path.resolve(projectRoot);
    }
  })();
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
        out.push({ name, description: descriptionOf(raw) });
      }
    }
  };
  walk(commandsDir, []);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
