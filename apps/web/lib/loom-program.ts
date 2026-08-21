"use client";

/**
 * THE PROGRAM DOC, READ ONCE AND NOT POLLED.
 *
 * `.telar/loom.md` is an ARTIFACT, not a live record: it changes when a human
 * edits it or when the orchestrator writes back, and both of those go through
 * this client. So it is fetched on mount and re-rendered from the PUT's own
 * response — polling a file nobody is changing would be a request storm for a
 * screen that never moves, and it is why the deck's one-call rule does not
 * reach here: a Program cannot disagree with a loom about anything.
 *
 * A SAVE RE-RENDERS FROM THE ENGINE'S ANSWER, never from the markdown that was
 * sent. The engine round-trips through `parseProgram`/`renderProgram`, so what
 * comes back is the canonical text plus the warnings the parse produced — and
 * a warning is exactly the thing a UI that echoed its own input would hide.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LoomProgramDoc } from "@telar/engine-client";
import { saveLoomProgram } from "./loom-actions";

export type LoomProgramView = {
  doc?: LoomProgramDoc;
  loading: boolean;
  saving: boolean;
  error?: string;
  /** Write the whole file. Returns false and sets `error` when the engine refuses. */
  save: (markdown: string) => Promise<boolean>;
  reload: () => void;
};

export function useLoomProgram(projectId: string | undefined): LoomProgramView {
  const [doc, setDoc] = useState<LoomProgramDoc>();
  const [loading, setLoading] = useState(Boolean(projectId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [awake, setAwake] = useState(0);

  const read = useCallback(async () => {
    if (!projectId) {
      setDoc(undefined);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/looms/program?project=${encodeURIComponent(projectId)}`);
      if (!res.ok) {
        setError(`The engine answered ${res.status} for this project's Program.`);
        setLoading(false);
        return;
      }
      setDoc((await res.json()) as LoomProgramDoc);
      setError(undefined);
    } catch {
      // Last good artifact stays up; a dropped read has not changed the file.
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Deferred to a task rather than run in the effect body — a synchronous
    // fetch-and-setState on mount is a cascading render, and this app lints it.
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read, awake]);

  const save = useCallback(
    async (markdown: string) => {
      if (!projectId) return false;
      setSaving(true);
      const result = await saveLoomProgram<LoomProgramDoc>(projectId, markdown);
      setSaving(false);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setDoc(result.data);
      setError(undefined);
      return true;
    },
    [projectId],
  );

  return useMemo(
    () => ({
      ...(doc ? { doc } : {}),
      loading,
      saving,
      ...(error ? { error } : {}),
      save,
      reload: () => setAwake((n) => n + 1),
    }),
    [doc, loading, saving, error, save],
  );
}

/**
 * The Programs of SEVERAL projects, for the deck's "what was already tried".
 *
 * A row in **Needs you** has to name the rungs that ran, and rung labels live
 * in the artifact rather than on the loom — the engine does not interpret rung
 * text, so it never copies it onto the record. This reads one file per project
 * that actually has something asking, once, and re-reads only when that set
 * changes. A deck with nothing waiting on a person fetches nothing at all.
 */
export function useLoomPrograms(projectIds: readonly string[]): {
  docs: Map<string, LoomProgramDoc>;
  reload: () => void;
} {
  const [docs, setDocs] = useState<Map<string, LoomProgramDoc>>(new Map());
  const [awake, setAwake] = useState(0);
  // The dependency is the SET, spelled as a stable string: passing the array
  // itself would re-fetch on every render, since a new array is a new value.
  // JSON rather than a joined string, because an id is opaque and any separator
  // picked here would eventually be a character inside one.
  const key = JSON.stringify([...new Set(projectIds)].sort());

  useEffect(() => {
    if (key === "[]") return;
    let cancelled = false;
    const task = window.setTimeout(() => {
      void (async () => {
        const ids = JSON.parse(key) as string[];
        const results = await Promise.all(
          ids.map(async (projectId) => {
            try {
              const res = await fetch(`/api/looms/program?project=${encodeURIComponent(projectId)}`);
              if (!res.ok) return undefined;
              return (await res.json()) as LoomProgramDoc;
            } catch {
              return undefined;
            }
          }),
        );
        if (cancelled) return;
        const next = new Map<string, LoomProgramDoc>();
        for (const doc of results) if (doc) next.set(doc.projectId, doc);
        setDocs(next);
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [key, awake]);

  return { docs, reload: () => setAwake((n) => n + 1) };
}
