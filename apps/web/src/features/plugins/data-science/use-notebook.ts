"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { claimCellDraft, claimCellDrafts, draftScope, forgetCellDraft, newDraftOwner, rememberCellDraft } from "@/features/files";
import type { KernelState, NotebookRead } from "./ds";

type NotebookApi = ReturnType<typeof createEngineApi>;
export type NotebookEdit = Parameters<NotebookApi["notebookEdit"]>[2];

const SAVE_DEBOUNCE_MS = 600;

export type NotebookReadFailure = { kind: "missing" } | { kind: "unreadable"; message: string };

const MISSING_FILE = /no such file in this workspace/i;
const NOT_THE_FILE = /\bmethod\b|\bplugin\b|\bendpoint\b|\bhas no\b|\broute\b/i;

export function classifyNotebookRead(cause: unknown): NotebookReadFailure {
  const message = cause instanceof EngineApiError ? cause.message : cause instanceof Error ? cause.message : "";
  const code = cause instanceof EngineApiError ? cause.code : undefined;
  if (code === "not_found" && MISSING_FILE.test(message) && !NOT_THE_FILE.test(message)) return { kind: "missing" };
  return {
    kind: "unreadable",
    message: message.trim() || "The engine did not answer.",
  };
}

function useCellDrafts({
  api,
  sessionId,
  path,
  scope,
  nb,
  setNb,
  setProblem,
}: {
  api: NotebookApi;
  sessionId: string | undefined;
  path: string;
  scope: string;
  nb: NotebookRead | undefined;
  setNb: (nb: NotebookRead) => void;
  setProblem: (problem: string | undefined) => void;
}) {
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const timers = useRef<Map<string, number>>(new Map());
  const owner = useRef(newDraftOwner());
  const stash = useRef(new Map<string, string>());

  useEffect(() => {
    const adopted = claimCellDrafts(scope, path, owner.current);
    if (adopted.size === 0) return;
    stash.current = new Map(adopted);
    setDrafts((current) => {
      const merged = new Map(current);
      for (const [cellId, text] of adopted) if (!merged.has(cellId)) merged.set(cellId, text);
      return merged;
    });
  }, [scope, path]);

  const saveCell = useCallback(
    async (cellId: string): Promise<NotebookRead | undefined> => {
      if (!sessionId) return undefined;
      const draft = drafts.get(cellId);
      if (draft === undefined) return nb;
      try {
        await api.notebookEdit(sessionId, path, { kind: "set", cellId, source: draft });
        const next = await api.notebook(sessionId, path, { withOutputs: true });
        setDrafts((current) => {
          const copy = new Map(current);
          if (copy.get(cellId) === draft) copy.delete(cellId);
          return copy;
        });
        if (stash.current.get(cellId) === draft) forgetCellDraft(scope, path, cellId, owner.current);
        setNb(next);
        setProblem(undefined);
        return next;
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : "Could not save.");
        return undefined;
      }
    },
    [sessionId, path, drafts, nb, api, scope, setNb, setProblem],
  );

  const saveCellRef = useRef(saveCell);
  useEffect(() => {
    saveCellRef.current = saveCell;
  }, [saveCell]);
  const edit = (cellId: string, source: string) => {
    setDrafts((current) => new Map(current).set(cellId, source));
    stash.current.set(cellId, source);
    claimCellDraft(scope, path, cellId, owner.current);
    rememberCellDraft(scope, path, cellId, source, owner.current);
    const existing = timers.current.get(cellId);
    if (existing) window.clearTimeout(existing);
    timers.current.set(cellId, window.setTimeout(() => void saveCellRef.current(cellId), SAVE_DEBOUNCE_MS));
  };
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [cellId, timer] of pending) {
        window.clearTimeout(timer);
        void saveCellRef.current(cellId);
      }
      pending.clear();
    };
  }, []);

  const saveAll = async () => {
    for (const id of [...drafts.keys()]) await saveCell(id);
  };

  return { drafts, edit, saveAll, clearDrafts: () => setDrafts(new Map()) };
}

export function useNotebook({ path, sessionId, hostId, active }: { path: string; sessionId?: string | undefined; hostId?: string | undefined; active?: TurnState | undefined }) {
  const [nb, setNb] = useState<NotebookRead>();
  const [failure, setFailure] = useState<NotebookReadFailure>();
  const [read, setRead] = useState(false);
  const [kernel, setKernel] = useState<KernelState>("none");
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const api = useMemo(() => createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [hostId]);
  const scope = draftScope(hostId, sessionId);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const answer = await api.notebook(sessionId, path, { withOutputs: true });
      setNb(answer);
      setFailure(undefined);
    } catch (cause) {
      setFailure(classifyNotebookRead(cause));
    } finally {
      setRead(true);
    }
  }, [sessionId, path, api]);

  const refreshKernel = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.kernel(sessionId);
      setKernel(status.state);
    } catch {
      setKernel("none");
    }
  }, [sessionId, api]);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void load();
      void refreshKernel();
    }, 0);
    return () => window.clearTimeout(first);
  }, [load, refreshKernel, active]);

  const [opened, setOpened] = useState(`${scope}\u0000${path}`);
  if (opened !== `${scope}\u0000${path}`) {
    setOpened(`${scope}\u0000${path}`);
    setNb(undefined);
    setFailure(undefined);
    setRead(false);
  }

  const cellDrafts = useCellDrafts({ api, sessionId, path, scope, nb, setNb, setProblem });

  const attempt = async (work: () => Promise<void>, fallback: string) => {
    try {
      await work();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : fallback);
    }
  };

  const create = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      setNb(await api.notebookEdit(sessionId, path, { kind: "create" }));
      setFailure(undefined);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not create.");
    } finally {
      setBusy(false);
    }
  };

  const run = async (cellId?: string) => {
    if (!sessionId || !nb) return;
    await cellDrafts.saveAll();
    setRunning((current) => new Set(current).add(cellId ?? "*"));
    setKernel((state) => (state === "none" ? "starting" : "busy"));
    await attempt(async () => {
      await api.notebookRun(sessionId, path, cellId ? { cellId } : { all: true });
      setNb(await api.notebook(sessionId, path, { withOutputs: true }));
      setProblem(undefined);
    }, "Could not run.");
    setRunning((current) => {
      const copy = new Set(current);
      copy.delete(cellId ?? "*");
      return copy;
    });
    void refreshKernel();
  };

  const structural = async (edit: NotebookEdit) => {
    if (!sessionId) return;
    setBusy(true);
    await attempt(async () => {
      await api.notebookEdit(sessionId, path, edit);
      setNb(await api.notebook(sessionId, path, { withOutputs: true }));
      setProblem(undefined);
    }, "Could not edit.");
    setBusy(false);
  };

  return { api, nb, failure, read, kernel, running, busy, problem, load, refreshKernel, create, run, structural, ...cellDrafts };
}
