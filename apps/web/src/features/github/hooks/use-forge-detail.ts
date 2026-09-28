import { useCallback, useEffect, useState } from "react";
import type { GitHubIssueDetail, GitHubPullDetail } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import type { UNAVAILABLE } from "../github-forge";

const api = createEngineApi();

/** One issue or pull request, read on mount and on refresh only: it never polls. */
export function useForgeDetail({ kind, number, projectId }: { kind: "issue" | "pull"; number: number; projectId: string | undefined }) {
  const [issue, setIssue] = useState<GitHubIssueDetail>();
  const [pull, setPull] = useState<GitHubPullDetail>();
  const [absent, setAbsent] = useState<{ unavailable: keyof typeof UNAVAILABLE; message?: string }>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return;
      try {
        const read =
          kind === "issue"
            ? await api.projectIssue(projectId, number, force ? { refresh: true } : {})
            : await api.projectPull(projectId, number, force ? { refresh: true } : {});
        if ("issue" in read) {
          setIssue(read.issue);
          setAbsent(undefined);
        } else if ("pull" in read) {
          setPull(read.pull);
          setAbsent(undefined);
        } else {
          setAbsent({ unavailable: read.unavailable, ...(read.message ? { message: read.message } : {}) });
        }
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId, kind, number],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };

  return { issue, pull, setPull, absent, error, refreshing, refresh };
}
