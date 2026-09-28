import { MAX_COMMENT_BODY } from "@telar/engine-client";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { GitHubLink, GitHubUnavailable } from "@telar/engine-client";

export type GhResult = { status: number; stdout: string; stderr: string };
export type GhRunner = (cwd: string, args: string[]) => Promise<GhResult>;

const GH_TIMEOUT_MS = 20_000;

export const GITHUB_PAGE_SIZE = 50;

export const defaultGhRunner: GhRunner = (cwd, args) =>
  new Promise((resolve) => {
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      resolve({ status: 126, stdout: "", stderr: `${cwd} is not a directory on this machine` });
      return;
    }
    execFile(
      "gh",
      args,
      { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        if (!failure) return resolve({ status: 0, stdout, stderr });
        const status = typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1;
        resolve({ status, stdout, stderr: stderr || failure.message });
      },
    );
  });

export function classifyGhFailure(result: GhResult): { unavailable: GitHubUnavailable; message?: string } {
  if (result.status === 127) return { unavailable: "not_installed" };
  if (result.status === 126) return { unavailable: "no_checkout" };
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (text.includes("known github host") || text.includes("none of the git remotes")) {
    return { unavailable: "not_github" };
  }
  if (text.includes("not logged in") || text.includes("authentication") || text.includes("gh auth login")) {
    return { unavailable: "not_authenticated" };
  }
  if (text.includes("not a git repository") || text.includes("no git remotes") || text.includes("could not determine")) {
    return { unavailable: "no_repository" };
  }
  const message = result.stderr.trim() || result.stdout.trim();
  return { unavailable: "failed", ...(message ? { message } : {}) };
}

export function epoch(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function login(value: unknown): string | undefined {
  const record = value as { login?: unknown } | null;
  const name = typeof record?.login === "string" ? record.login : "";
  return name || undefined;
}

function isBot(value: unknown): boolean {
  const record = value as { is_bot?: unknown; login?: unknown } | null;
  if (record?.is_bot === true) return true;
  return typeof record?.login === "string" && record.login.startsWith("app/");
}

export function avatar(value: unknown, url: string): string | undefined {
  const name = login(value);
  if (!name || isBot(value) || !isGitHubDotCom(url)) return undefined;
  return `https://github.com/${encodeURIComponent(name)}.png`;
}

function isGitHubDotCom(url: string): boolean {
  const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1]?.toLowerCase();
  return host === undefined || host === "github.com" || host === "www.github.com";
}

export function authorOf(value: unknown, url: string) {
  const name = login(value);
  const face = avatar(value, url);
  return {
    ...(name ? { author: name } : {}),
    ...(face ? { authorAvatar: face } : {}),
  };
}

export function parseRepoFromUrl(url: string): string | undefined {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(?:issues|pull)\//.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function links(value: unknown, self: string | undefined): GitHubLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const number = typeof row.number === "number" ? row.number : 0;
    if (number <= 0) return [];
    const repo = row.repository as { name?: unknown; owner?: { login?: unknown } } | null;
    const owner = text(repo?.owner?.login);
    const name = text(repo?.name);
    const where = owner && name ? `${owner}/${name}` : "";
    return [
      {
        number,
        url: text(row.url) || `#${number}`,
        ...(where && where !== self ? { repository: where } : {}),
      },
    ];
  });
}

export function labels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    const record = label as Record<string, unknown>;
    const name = text(record.name);
    return name ? [{ name, ...(text(record.color) ? { color: text(record.color) } : {}) }] : [];
  });
}

export function logins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = login(entry);
    return name ? [name] : [];
  });
}

export function milestone(value: unknown): string | undefined {
  const title = text((value as { title?: unknown } | null)?.title);
  return title || undefined;
}

export function bodyRefusal(body: string, noun: string): string | undefined {
  if (!body) return `A ${noun} needs something in it.`;
  if (body.length > MAX_COMMENT_BODY) return `That ${noun} is ${body.length} characters; GitHub takes at most ${MAX_COMMENT_BODY}.`;
  return undefined;
}
