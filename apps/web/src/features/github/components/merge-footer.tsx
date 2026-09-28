"use client";

import { useMemo, useState } from "react";
import { CheckIcon, GitMergeIcon, TriangleAlertIcon } from "lucide-react";
import type { GitHubMergeMethod, GitHubMergeRefusal, GitHubPullDetail } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Spinner } from "@/ui/spinner";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { MERGE_REFUSAL, mergeReadiness } from "../github-forge";
import { cn } from "@/ui/utils";
import { METHOD_LABEL } from "../model";

const api = createEngineApi();

type Problem = { refusal: GitHubMergeRefusal; message?: string };

function MergeHome({ base, children }: { base?: string; children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-border bg-card px-3 py-2">
      <p className="mb-1.5 truncate font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">merge into {base ?? "its base branch"}</p>
      {children}
    </div>
  );
}

function MergeProblem({ problem, onDismiss, onReread }: { problem: Problem; onDismiss: () => void; onReread: () => void }) {
  return (
    <div className="flex items-start gap-2 text-2xs leading-snug">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        {MERGE_REFUSAL[problem.refusal]}
        {problem.message && <span className="block text-muted-foreground">{problem.message}</span>}
        {problem.refusal === "head_moved" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="mt-1.5"
            onClick={() => {
              onDismiss();
              onReread();
            }}
          >
            Re-read this pull request
          </Button>
        ) : (
          <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </span>
    </div>
  );
}

function MergeConfirm({ pull, method, merging, onCancel, onMerge }: { pull: GitHubPullDetail; method: GitHubMergeMethod; merging: boolean; onCancel: () => void; onMerge: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs leading-snug">
        {METHOD_LABEL[method]} <span className="font-mono">#{pull.number}</span> into <span className="font-mono">{pull.baseRefName ?? "its base branch"}</span>?{" "}
        <span className="text-muted-foreground">This happens on GitHub and cannot be undone from Telar.</span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={merging}>
          Cancel
        </Button>
        <Button type="button" size="xs" onClick={onMerge} disabled={merging}>
          {merging ? <Spinner className="size-3" /> : <GitMergeIcon className="size-3" />}
          {merging ? "Merging…" : "Merge"}
        </Button>
      </div>
    </div>
  );
}

function MergeControls({
  pull,
  methods,
  method,
  onChoose,
  onArm,
}: {
  pull: GitHubPullDetail;
  methods: readonly GitHubMergeMethod[];
  method: GitHubMergeMethod;
  onChoose: (method: GitHubMergeMethod) => void;
  onArm: () => void;
}) {
  const readiness = useMemo(() => mergeReadiness(pull), [pull]);
  return (
    <div className="flex flex-col gap-1.5">
      {readiness.note && <p className={cn("text-2xs leading-snug", readiness.canMerge ? "text-muted-foreground" : "text-warning")}>{readiness.note}</p>}
      <div className="flex items-center gap-1">
        <Button type="button" size="xs" disabled={!readiness.canMerge} onClick={onArm} className="min-w-0">
          <GitMergeIcon className="size-3" />
          <span className="truncate">{METHOD_LABEL[method]}</span>
        </Button>
        {methods.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Choose how to merge"
                  title="Choose how to merge"
                  disabled={!readiness.canMerge}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                />
              }
            >
              <span aria-hidden className="text-3xs">
                ▾
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {methods.map((candidate) => (
                <DropdownMenuItem key={candidate} onClick={() => onChoose(candidate)}>
                  {candidate === method && <CheckIcon />}
                  <span className="truncate">{METHOD_LABEL[candidate]}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

/** Two presses: the first arms and spells out the merge, the second sends it pinned to the head commit that was read. */
export function MergeFooter({ pull, onMerged, onReread, projectId }: { pull: GitHubPullDetail; onMerged: (merged: GitHubPullDetail) => void; onReread: () => void; projectId: string }) {
  const methods = pull.mergeMethods.length > 0 ? pull.mergeMethods : (["merge", "squash", "rebase"] as GitHubMergeMethod[]);
  const [chosen, setChosen] = useState<GitHubMergeMethod>();
  const method = (chosen && methods.includes(chosen) ? chosen : methods[0]) ?? "merge";
  const [armed, setArmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const base = pull.baseRefName ? { base: pull.baseRefName } : {};

  if (pull.state.toUpperCase() !== "OPEN") return null;
  const head = pull.headRefOid;
  if (!head) {
    return (
      <MergeHome {...base}>
        <p className="text-2xs leading-snug text-muted-foreground">gh did not report this branch&apos;s head commit, so merging is not offered.</p>
      </MergeHome>
    );
  }

  const merge = async () => {
    setMerging(true);
    setProblem(undefined);
    try {
      const result = await api.mergeProjectPull(projectId, pull.number, { method, expectedHeadOid: head });
      if (result.merged) {
        setArmed(false);
        onMerged(result.pull);
        return;
      }
      setProblem({ refusal: result.refusal, ...(result.message ? { message: result.message } : {}) });
    } catch (cause) {
      setProblem({ refusal: "failed", message: cause instanceof EngineApiError ? cause.message : "The merge could not be sent." });
    } finally {
      setMerging(false);
      setArmed(false);
    }
  };

  return (
    <MergeHome {...base}>
      {problem ? (
        <MergeProblem problem={problem} onDismiss={() => setProblem(undefined)} onReread={onReread} />
      ) : armed ? (
        <MergeConfirm pull={pull} method={method} merging={merging} onCancel={() => setArmed(false)} onMerge={() => void merge()} />
      ) : (
        <MergeControls pull={pull} methods={methods} method={method} onChoose={setChosen} onArm={() => setArmed(true)} />
      )}
    </MergeHome>
  );
}
