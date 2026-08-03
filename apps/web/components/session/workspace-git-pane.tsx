"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareArrowsIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import type { GitOverviewResponse } from "@/components/projects/git-tab-shared";
import { cachedJson } from "@/lib/client-json-cache";
import type {
  GitActionResponse,
  GitDiffResponse,
  GitFileStatus,
  GitWorkspaceStatusResponse,
} from "@/lib/git-workspace-contract";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import { cn } from "@/lib/utils";

export type WorkspaceGitPane = "changes" | "branch" | "commit" | "compare";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function PaneHeader({ title, onBack, action }: {
  title: string;
  onBack: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-9 items-center gap-2 px-1">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to workspace summary"
        className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {action}
    </div>
  );
}

function ResultNotice({ error, message }: { error: string | null; message: string | null }) {
  if (!error && !message) return null;
  return (
    <p className={cn(
      "mx-1 my-2 rounded-xl px-3 py-2 text-xs leading-relaxed",
      error ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-500",
    )}>
      {error ?? message}
    </p>
  );
}

function FileBadge({ file }: { file: GitFileStatus }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
      {file.additions > 0 && <span className="text-emerald-500">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-destructive">−{file.deletions}</span>}
      {file.binary && <span className="text-muted-foreground">bin</span>}
    </span>
  );
}

export function WorkspaceGitPaneContent({
  pane,
  project,
  overview,
  onBack,
}: {
  pane: WorkspaceGitPane;
  project: string;
  overview: GitOverviewResponse | null;
  onBack: () => void;
}) {
  const baseUrl = `/api/projects/${encodeURIComponent(project)}/git`;
  const [status, setStatus] = useState<GitWorkspaceStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [compareBase, setCompareBase] = useState(
    overview?.defaultBranch && overview.defaultBranch !== overview.header.branch
      ? overview.defaultBranch
      : overview?.branches.find((branch) => !branch.current)?.name ?? "",
  );

  const loadStatus = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await cachedJson<GitWorkspaceStatusResponse>(`${baseUrl}/status`, {
        maxAgeMs: 5_000,
        force,
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    let live = true;
    void cachedJson<GitWorkspaceStatusResponse>(`${baseUrl}/status`, { maxAgeMs: 5_000 })
      .then((nextStatus) => {
        if (live) setStatus(nextStatus);
      })
      .catch((nextError) => {
        if (live) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [baseUrl]);

  const mutate = useCallback(async (
    endpoint: string,
    body?: Record<string, unknown>,
  ) => {
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const result = await responseJson<GitActionResponse>(await fetch(`${baseUrl}/${endpoint}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }));
      setMessage(result.message);
      await loadStatus(true);
      dispatchTelarRefresh({ domains: ["git"], project });
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    } finally {
      setWorking(false);
    }
  }, [baseUrl, loadStatus, project]);

  const loadDiff = useCallback(async (filePath?: string, base?: string) => {
    setError(null);
    setDiff(null);
    const search = new URLSearchParams({ scope: base ? "compare" : "all" });
    if (filePath) search.set("path", filePath);
    if (base) search.set("base", base);
    try {
      setDiff(await responseJson<GitDiffResponse>(await fetch(`${baseUrl}/diff?${search}`)));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [baseUrl]);

  useEffect(() => {
    if (pane !== "compare" || !compareBase) return;
    let live = true;
    const search = new URLSearchParams({ scope: "compare", base: compareBase });
    void fetch(`${baseUrl}/diff?${search}`)
      .then((response) => responseJson<GitDiffResponse>(response))
      .then((nextDiff) => {
        if (live) setDiff(nextDiff);
      })
      .catch((nextError) => {
        if (live) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => { live = false; };
  }, [baseUrl, compareBase, pane]);

  const availableBranches = useMemo(
    () => (overview?.branches ?? []).filter((branch) => !branch.current),
    [overview],
  );

  if (pane === "changes") {
    return (
      <div>
        <PaneHeader
          title="Changes"
          onBack={onBack}
          action={
            <button
              type="button"
              onClick={() => void loadStatus(true)}
              aria-label="Refresh changes"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          }
        />
        <ResultNotice error={error} message={message} />
        {loading && !status ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
          </div>
        ) : status?.files.length ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
              <span>{status.summary.files} files</span>
              <span className="text-emerald-500">+{status.summary.additions}</span>
              <span className="text-destructive">−{status.summary.deletions}</span>
              <button
                type="button"
                disabled={working}
                onClick={() => void mutate("stage", {
                  paths: status.files.map((file) => file.path),
                  staged: true,
                })}
                className="ml-auto rounded-lg px-2 py-1 hover:bg-muted disabled:opacity-50"
              >
                Stage all
              </button>
            </div>
            {status.files.slice(0, 60).map((file) => (
              <div key={file.path} className="rounded-xl bg-muted/25">
                <button
                  type="button"
                  onClick={() => {
                    const next = selectedPath === file.path ? null : file.path;
                    setSelectedPath(next);
                    setDiff(null);
                    if (next) void loadDiff(next);
                  }}
                  className="flex min-h-9 w-full items-center gap-2 px-2.5 text-left"
                >
                  <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {file.untracked ? "U" : `${file.indexStatus}${file.worktreeStatus}`.trim()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{file.path}</span>
                  <FileBadge file={file} />
                </button>
                {selectedPath === file.path && (
                  <div className="border-t border-border/60 px-2 pb-2 pt-1.5">
                    <div className="mb-1.5 flex items-center gap-1">
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => void mutate("stage", { paths: [file.path], staged: !file.staged })}
                        className="rounded-lg bg-muted px-2 py-1 text-[10px] hover:bg-muted/80 disabled:opacity-50"
                      >
                        {file.staged ? "Unstage" : "Stage"}
                      </button>
                    </div>
                    {!diff ? (
                      <div className="flex h-16 items-center justify-center text-muted-foreground">
                        <LoaderCircleIcon className="size-3.5 animate-spin" />
                      </div>
                    ) : diff.binary ? (
                      <p className="px-1 py-3 text-center text-xs text-muted-foreground">Binary file changed.</p>
                    ) : (
                      <pre className="max-h-52 overflow-auto rounded-lg bg-background/70 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                        {diff.patch || "No textual diff."}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <CheckIcon className="size-5 text-emerald-500" />
            Working tree is clean
          </div>
        )}
      </div>
    );
  }

  if (pane === "branch") {
    return (
      <div>
        <PaneHeader title="Branches" onBack={onBack} />
        <ResultNotice error={error} message={message} />
        <div className="rounded-xl bg-muted/30 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Current branch</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-medium">
            <GitBranchIcon className="size-4 text-muted-foreground" />
            {status?.branch ?? overview?.header.branch ?? "Current checkout"}
          </p>
        </div>
        <div className="mt-2 space-y-0.5">
          {availableBranches.slice(0, 24).map((branch) => (
            <button
              key={branch.name}
              type="button"
              disabled={working}
              onClick={() => void mutate("branches", { name: branch.name })}
              className="flex min-h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left hover:bg-muted disabled:opacity-50"
            >
              <GitBranchIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{branch.name}</span>
              <span className="text-[10px] text-muted-foreground">↑{branch.ahead} ↓{branch.behind}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1.5 border-t border-border pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate("branches", { name: branchName, create: true }).then((ok) => {
              if (ok) setBranchName("");
            });
          }}
        >
          <input
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder="new-branch"
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-ring"
          />
          <button
            type="submit"
            disabled={working || !branchName.trim()}
            className="flex h-8 items-center gap-1 rounded-lg bg-muted px-2.5 text-xs hover:bg-muted/80 disabled:opacity-50"
          >
            <PlusIcon className="size-3.5" /> Create
          </button>
        </form>
      </div>
    );
  }

  if (pane === "commit") {
    const staged = status?.files.filter((file) => file.staged) ?? [];
    return (
      <div>
        <PaneHeader title="Commit and push" onBack={onBack} />
        <ResultNotice error={error} message={message} />
        <div className="rounded-xl bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>{staged.length} staged</span>
            <span>{status?.summary.files ?? 0} changed</span>
          </div>
          {staged.slice(0, 4).map((file) => (
            <p key={file.path} className="mt-1 truncate font-mono text-[10px]">{file.path}</p>
          ))}
        </div>
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Commit message"
          rows={3}
          className="mt-2 w-full resize-none rounded-xl border border-border bg-background p-2.5 text-xs outline-none focus:border-ring"
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={working || staged.length === 0 || !commitMessage.trim()}
            onClick={() => void mutate("commit", { message: commitMessage }).then((ok) => {
              if (ok) setCommitMessage("");
            })}
            className="flex h-9 items-center justify-center gap-2 rounded-xl bg-foreground text-xs font-medium text-background disabled:opacity-40"
          >
            <GitCommitHorizontalIcon className="size-3.5" /> Commit
          </button>
          <button
            type="button"
            disabled={working || Boolean(status?.summary.files)}
            onClick={() => void mutate("push")}
            className="flex h-9 items-center justify-center gap-2 rounded-xl border border-border text-xs font-medium hover:bg-muted disabled:opacity-40"
          >
            <RotateCwIcon className={cn("size-3.5", working && "animate-spin")} /> Push
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PaneHeader title="Compare branch" onBack={onBack} />
      <ResultNotice error={error} message={message} />
      <div className="relative">
        <GitCompareArrowsIcon className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <select
          value={compareBase}
          onChange={(event) => {
            setCompareBase(event.target.value);
            setDiff(null);
            setError(null);
          }}
          className="h-9 w-full appearance-none rounded-xl border border-border bg-background pl-8 pr-3 text-xs outline-none focus:border-ring"
        >
          <option value="">Select a branch</option>
          {availableBranches.map((branch) => (
            <option key={branch.name} value={branch.name}>{branch.name}</option>
          ))}
        </select>
      </div>
      {compareBase && !diff ? (
        <div className="flex h-28 items-center justify-center text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
        </div>
      ) : diff ? (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
            <MinusIcon className="size-3" /> {compareBase}…{status?.branch ?? "HEAD"}
          </div>
          <pre className="max-h-96 overflow-auto rounded-xl bg-muted/30 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
            {diff.patch || "No differences."}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
