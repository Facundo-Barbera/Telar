import { withSessionMarker } from "./attribution";
import type { GitHubPullCreateRefusal, GitHubPullCreateResult, DiffHunkRange, GitHubLineCommentInput, GitHubLineCommentResult, GitHubPullAnchor } from "@telar/engine-client";
import { MAX_COMMENT_BODY, MAX_PULL_TITLE } from "@telar/engine-client";
import { bodyRefusal, type GhResult, type GhRunner, text } from "./gh";
import { classifyGraphqlWriteFailure, parseCommentUrl } from "./writes";

function pullForBranchArgv(branch: string): string[] {
  return ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "number,url,headRefOid,baseRefName"];
}

export async function readPullForBranch(gh: GhRunner, cwd: string, branch: string): Promise<GitHubPullAnchor["pull"]> {
  const result = await gh(cwd, pullForBranchArgv(branch));
  if (result.status !== 0) return undefined;
  try {
    const row = (JSON.parse(result.stdout) as Record<string, unknown>[])[0];
    const number = typeof row?.number === "number" ? row.number : undefined;
    const url = text(row?.url);
    const headRefOid = text(row?.headRefOid);
    const baseRefName = text(row?.baseRefName);
    return number && url && headRefOid && baseRefName ? { number, url, headRefOid, baseRefName } : undefined;
  } catch {
    return undefined;
  }
}

function pullFilesArgv(number: number): string[] {
  return ["api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/files`, "--jq", '.[] | [.filename, (.patch // "")]'];
}

export function hunkRanges(patch: string): DiffHunkRange[] {
  const hunks: DiffHunkRange[] = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

export async function readPullFiles(gh: GhRunner, cwd: string, number: number): Promise<GitHubPullAnchor["files"]> {
  const result = await gh(cwd, pullFilesArgv(number));
  if (result.status !== 0) return [];
  const files: GitHubPullAnchor["files"] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const [path, patch] = JSON.parse(line) as unknown[];
      if (typeof path === "string" && path) files.push({ path, hunks: typeof patch === "string" ? hunkRanges(patch) : [] });
    } catch {
    }
  }
  return files;
}

export function lineCommentArgv(number: number, input: GitHubLineCommentInput): string[] {
  const argv = [
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/pulls/${number}/comments`,
    "-f",
    `body=${input.body}`,
    "-f",
    `commit_id=${input.commitId}`,
    "-f",
    `path=${input.path}`,
    "-F",
    `line=${input.line}`,
    "-f",
    `side=${input.side}`,
  ];
  if (input.startLine !== undefined) argv.push("-F", `start_line=${input.startLine}`, "-f", `start_side=${input.startSide ?? input.side}`);
  return argv;
}

export async function commentOnPullLine(gh: GhRunner, cwd: string, number: number, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
  const body = input.body.trim();
  const refused = bodyRefusal(body, "comment");
  if (refused) return { commented: false, refusal: "invalid_body", message: refused };
  const result = await gh(cwd, lineCommentArgv(number, { ...input, body }));
  if (result.status === 0) {
    try {
      const url = text((JSON.parse(result.stdout) as { html_url?: unknown }).html_url);
      if (url) return { commented: true, url };
    } catch {
    }
  }
  const lower = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const classified = classifyGraphqlWriteFailure(result);
  if (lower.includes("auth refresh") || lower.includes("scope")) return { commented: false, ...classified, refusal: "scope" };
  if (lower.includes("http 404")) return { commented: false, ...classified, refusal: "not_found" };
  return { commented: false, ...classified };
}

function classifyPullCreateFailure(result: GhResult): { refusal: GitHubPullCreateRefusal; message?: string; url?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  if (text.includes("already exists")) {
    const url = firstUrl(`${result.stderr}\n${result.stdout}`);
    return { refusal: "exists", ...carry, ...(url ? { url } : {}) };
  }
  if (text.includes("no commits between") || text.includes("must be different")) {
    return { refusal: "nothing_to_compare", ...carry };
  }
  if (
    text.includes("http 403") ||
    text.includes("write access") ||
    text.includes("permission") ||
    text.includes("not accessible") ||
    text.includes("must have")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  return { refusal: "failed", ...carry };
}

function firstUrl(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim();
    if (/^https?:\/\/\S+$/.test(candidate)) return candidate;
  }
  return undefined;
}

export function parsePullNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function openPullRequest(
  gh: GhRunner,
  cwd: string,
  input: { head: string; base: string; title: string; body: string; sessionId: string },
): Promise<GitHubPullCreateResult> {
  const title = input.title.trim();
  if (!title) return { opened: false, refusal: "invalid_title", message: "A pull request needs a title." };
  if (title.length > MAX_PULL_TITLE) {
    return {
      opened: false,
      refusal: "invalid_title",
      message: `That title is ${title.length} characters; GitHub takes at most ${MAX_PULL_TITLE}.`,
    };
  }
  if (input.head === input.base) {
    return { opened: false, refusal: "nothing_to_compare", message: `${input.head} is the base branch — there would be nothing to review.` };
  }
  if (input.body.length > MAX_COMMENT_BODY) {
    return {
      opened: false,
      refusal: "failed",
      message: `That description is ${input.body.length} characters; GitHub takes at most ${MAX_COMMENT_BODY}.`,
    };
  }
  let stamped: string;
  try {
    stamped = withSessionMarker(input.body, input.sessionId);
  } catch (error) {
    return { opened: false, refusal: "failed", message: error instanceof Error ? error.message : String(error) };
  }

  const created = await gh(cwd, ["pr", "create", "--head", input.head, "--base", input.base, "--title", title, "--body", stamped]);
  if (created.status !== 0) return { opened: false, ...classifyPullCreateFailure(created) };
  const url = parseCommentUrl(created.stdout) ?? firstUrl(created.stdout);
  if (!url) {
    return { opened: true, url: `${input.head} → ${input.base}`, attribution: { sessionId: input.sessionId } };
  }
  const number = parsePullNumber(url);
  return { opened: true, url, ...(number ? { number } : {}), attribution: { sessionId: input.sessionId } };
}
