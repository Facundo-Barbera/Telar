import type { GitChangeStatus, GitCommitEntry, GitWorktreeEntry } from "@telar/engine-client";


function basenameOf(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export function samePath(left: string, right: string, caseInsensitive = CASE_INSENSITIVE_FS): boolean {
  const normalise = (value: string) => {
    const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? unified.toLowerCase() : unified;
  };
  return normalise(left) === normalise(right);
}

export function parseWorktreeList(stdout: string, projectRoot: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: { path?: string; branch?: string } = {};
  const flush = () => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      basename: basenameOf(current.path),
      ...(current.branch ? { branch: current.branch } : {}),
      isMainCheckout: samePath(current.path, projectRoot),
    });
    current = {};
  };

  for (const line of stdout.split("\n")) {
    const value = line.trim();
    if (!value) {
      flush();
      continue;
    }
    if (value.startsWith("worktree ")) {
      flush();
      current.path = value.slice("worktree ".length).trim();
    } else if (value.startsWith("branch ")) {
      current.branch = value.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

export function countDirty(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | undefined {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

export function nulFields(stdout: string): string[] {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

export function parseNumstat(stdout: string): { path: string; renamedFrom?: string; added?: number; removed?: number; binary: boolean }[] {
  const out: { path: string; renamedFrom?: string; added?: number; removed?: number; binary: boolean }[] = [];
  const fields = nulFields(stdout);
  for (let index = 0; index < fields.length; index += 1) {
    const head = fields[index]!;
    const parts = head.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, first] = parts as [string, string, string];
    const binary = added === "-" || removed === "-";
    let path = first;
    let renamedFrom: string | undefined;
    if (first === "") {
      renamedFrom = fields[index + 1];
      path = fields[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    out.push({
      path,
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(binary ? {} : { added: Number(added), removed: Number(removed) }),
      binary,
    });
  }
  return out;
}

const NAME_STATUS: Record<string, GitChangeStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

export function parseNameStatus(stdout: string): Map<string, GitChangeStatus> {
  const out = new Map<string, GitChangeStatus>();
  const fields = nulFields(stdout);
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]!;
    const letter = code[0];
    if (!letter || !NAME_STATUS[letter]) continue;
    const renamed = letter === "R" || letter === "C";
    const path = renamed ? fields[index + 2] : fields[index + 1];
    index += renamed ? 2 : 1;
    if (path) out.set(path, NAME_STATUS[letter]!);
  }
  return out;
}

export function parseUntracked(stdout: string): string[] {
  return nulFields(stdout)
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

export function porcelainPaths(stdout: string): string[] {
  const fields = nulFields(stdout);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && fields[index + 1]) paths.push(fields[++index]!);
  }
  return paths;
}

const FIELD = "";
const RECORD = "";
export const GIT_LOG_FORMAT = `%H${FIELD}%h${FIELD}%s${FIELD}%at${FIELD}%an${RECORD}`;

export function parseGitLog(stdout: string): GitCommitEntry[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .flatMap((record) => {
      const [sha, shortSha, subject, at, author] = record.split(FIELD);
      if (!sha || !shortSha) return [];
      const seconds = Number(at);
      return [
        {
          sha,
          shortSha,
          subject: subject ?? "",
          at: Number.isFinite(seconds) ? seconds * 1000 : 0,
          author: author ?? "",
        },
      ];
    });
}

