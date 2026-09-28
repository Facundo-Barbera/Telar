import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubFacets, GitHubSnapshot } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import type { ForgeFilterChip } from "../github-forge";
import { clearChip, githubQuery, toggleLabel, type ForgeFilter, type ForgeListKind } from "../model";

const api = createEngineApi();

/** One list's read, filter and facets. Reads once per question and never while a detail is showing. */
export function useGitHubList({ projectId, kind, showingDetail }: { projectId: string | undefined; kind: ForgeListKind; showingDetail: boolean }) {
  const [snapshot, setSnapshot] = useState<GitHubSnapshot>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ForgeFilter>({ state: "open", labels: [] });
  const [facets, setFacets] = useState<GitHubFacets>();
  const [loadingFacets, setLoadingFacets] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return;
      try {
        const read = await api.projectGitHub(projectId, { ...(force ? { refresh: true } : {}), ...githubQuery(kind, filter) });
        setSnapshot(read.github);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId, kind, filter],
  );

  // `load` changes identity exactly when the question does, so it doubles as the "already asked" key.
  const issued = useRef<typeof load>(undefined);
  useEffect(() => {
    if (showingDetail || issued.current === load) return;
    issued.current = load;
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, showingDetail]);

  const refresh = () => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };

  const openFacets = useCallback(
    (open: boolean) => {
      if (!open || facets || loadingFacets || !projectId) return;
      setLoadingFacets(true);
      void api
        .projectForgeFacets(projectId)
        .then((read) => setFacets(read.facets))
        .catch(() => undefined)
        .finally(() => setLoadingFacets(false));
    },
    [facets, loadingFacets, projectId],
  );

  return {
    snapshot,
    error,
    refreshing,
    refresh,
    filter,
    facets,
    loadingFacets,
    openFacets,
    choose: (patch: Partial<ForgeFilter>) => setFilter((current) => ({ ...current, ...patch })),
    toggleLabel: (label: string) => setFilter((current) => toggleLabel(current, label)),
    clearChip: (chip: ForgeFilterChip) => setFilter((current) => clearChip(current, chip)),
    clearFilters: () => setFilter((current) => ({ state: current.state, labels: [] })),
  };
}

export type GitHubList = ReturnType<typeof useGitHubList>;
