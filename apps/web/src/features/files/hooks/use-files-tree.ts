"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitChangeStatus, TurnState, WorkspaceListing } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { ancestorsOf, buildFileTree, directoryPaths, flattenTree, matchFiles, type FileTreeNode } from "../file-tree";
import type { OpenIntent } from "../editor-workspace";

const api = createEngineApi();

export type FileTreeRowModel = { node: FileTreeNode; depth: number };

function useWorkspaceListing(sessionId: string | undefined, projectId: string | undefined, active: TurnState | undefined) {
  const [listing, setListing] = useState<WorkspaceListing>();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitChangeStatus>>(new Map());
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId && !projectId) return;
    const listFiles = () => (sessionId ? api.sessionFiles(sessionId) : api.projectFiles(projectId!));
    const readDiff = () => (sessionId ? api.sessionDiff(sessionId) : api.projectDiff(projectId!));
    try {
      const [listed, diff] = await Promise.all([listFiles(), readDiff().catch(() => undefined)]);
      setListing(listed.listing);
      setStatuses(new Map((diff?.diff.files ?? []).map((file) => [file.path, file.status])));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
    }
  }, [sessionId, projectId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  return { listing, statuses, error, refreshing, refresh };
}

function useTreeKeys({
  rows,
  expanded,
  toggle,
  onOpenFile,
}: {
  rows: FileTreeRowModel[];
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  onOpenFile: (path: string, intent: OpenIntent) => void;
}) {
  const [focusedPath, setFocusedPath] = useState<string>();
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());

  const focusRow = useCallback((path: string | undefined) => {
    if (path === undefined) return;
    setFocusedPath(path);
    rowsRef.current.get(path)?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.node.path === focusedPath);
    const row = rows[index];
    const step = (delta: number) => {
      event.preventDefault();
      focusRow(rows[Math.min(Math.max(index + delta, 0), rows.length - 1)]?.node.path);
    };
    if (event.key === "ArrowDown") return step(index === -1 ? 0 : 1);
    if (event.key === "ArrowUp") return step(-1);
    if (event.key === "Home") {
      event.preventDefault();
      return focusRow(rows[0]?.node.path);
    }
    if (event.key === "End") {
      event.preventDefault();
      return focusRow(rows[rows.length - 1]?.node.path);
    }
    if (!row) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.node.kind !== "directory") return;
      if (expanded.has(row.node.path)) return focusRow(rows[index + 1]?.node.path);
      return toggle(row.node.path);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.kind === "directory" && expanded.has(row.node.path)) return toggle(row.node.path);
      for (let above = index - 1; above >= 0; above -= 1) {
        if (rows[above]!.depth < row.depth) return focusRow(rows[above]!.node.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.node.kind === "directory") return toggle(row.node.path);
      return onOpenFile(row.node.path, "pin");
    }
  };

  return { focusedPath, setFocusedPath, rowsRef, onKeyDown };
}

export function useFilesTree({
  sessionId,
  projectId,
  reveal,
  active,
  onOpenFile,
}: {
  sessionId?: string | undefined;
  projectId?: string | undefined;
  reveal?: { path: string; nonce: number } | undefined;
  active?: TurnState | undefined;
  onOpenFile: (path: string, intent: OpenIntent) => void;
}) {
  const { listing, statuses, error, refreshing, refresh } = useWorkspaceListing(sessionId, projectId, active);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [shutWhileSearching, setShutWhileSearching] = useState<ReadonlySet<string>>(new Set());

  const searched = useMemo(() => matchFiles(listing?.files ?? [], query), [listing, query]);
  const tree = useMemo(() => buildFileTree(searched.files), [searched.files]);
  const searching = query.trim().length > 0;
  const expanded = useMemo(
    () => (searching ? new Set(directoryPaths(tree).filter((path) => !shutWhileSearching.has(path))) : opened),
    [searching, tree, shutWhileSearching, opened],
  );
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const dirty = useMemo(() => ancestorsOf(statuses.keys()), [statuses]);

  const toggle = useCallback(
    (path: string) => {
      const flip = (current: ReadonlySet<string>) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      };
      if (searching) setShutWhileSearching(flip);
      else setOpened(flip);
    },
    [searching],
  );

  const collapseAll = useCallback(() => {
    if (searching) setShutWhileSearching(new Set(directoryPaths(tree)));
    else setOpened(new Set());
  }, [searching, tree]);

  const search = useCallback((next: string) => {
    setQuery(next);
    setShutWhileSearching(new Set());
  }, []);

  const keys = useTreeKeys({ rows, expanded, toggle, onOpenFile });
  const { rowsRef } = keys;

  const revealPath = reveal?.path;
  const revealNonce = reveal?.nonce;
  const revealing = useRef<string>(undefined);
  useEffect(() => {
    if (!revealPath) return undefined;
    revealing.current = revealPath;
    const task = window.setTimeout(() => {
      setQuery("");
      setShutWhileSearching(new Set());
      setOpened((current) => new Set([...current, ...ancestorsOf([revealPath])]));
    }, 0);
    return () => window.clearTimeout(task);
  }, [revealPath, revealNonce]);

  useEffect(() => {
    const path = revealing.current;
    if (path === undefined) return;
    if (searching || ![...ancestorsOf([path])].every((directory) => expanded.has(directory))) return;
    revealing.current = undefined;
    rowsRef.current.get(path)?.scrollIntoView({ block: "nearest" });
  }, [searching, expanded, rows, rowsRef]);

  return { listing, statuses, error, refreshing, refresh, query, search, searched, searching, expanded, rows, dirty, toggle, collapseAll, ...keys };
}
