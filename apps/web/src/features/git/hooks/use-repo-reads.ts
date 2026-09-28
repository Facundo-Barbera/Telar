"use client";

import { useEffect, useState } from "react";
import type { GitRefEntry } from "@telar/engine-client";
import type { DiffScopeKind } from "@/lib/diff-scope";
import { api } from "../api";

/** The project's refs, read once and only when the branch scope needs a base to choose. */
export function useGitRefs(kind: DiffScopeKind, projectId: string | undefined) {
  const [refs, setRefs] = useState<readonly GitRefEntry[]>();
  useEffect(() => {
    if (kind !== "branch" || refs !== undefined || !projectId) return;
    let cancelled = false;
    void api
      .projectGit(projectId)
      .then((answer) => {
        if (!cancelled) setRefs(answer.git.refs ?? []);
      })
      .catch(() => {
        if (!cancelled) setRefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, refs, projectId]);
  return refs;
}

/** Whether a pull request can be opened for this project, read once; a failed read counts as no. */
export function useGitHubReady(publishable: boolean, projectId: string | undefined) {
  const [github, setGithub] = useState<boolean>();
  useEffect(() => {
    if (!publishable || !projectId || github !== undefined) return;
    let cancelled = false;
    void api
      .projectGitHub(projectId)
      .then((answer) => {
        if (!cancelled) setGithub(answer.github.unavailable === undefined);
      })
      .catch(() => {
        if (!cancelled) setGithub(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publishable, projectId, github]);
  return github;
}
