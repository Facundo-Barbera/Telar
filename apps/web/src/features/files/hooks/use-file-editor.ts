import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TurnState, WorkspaceFile } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { claimDraft, draftScope, forgetDraft, newDraftOwner, rememberDraft, type DraftOwner } from "../editor-drafts";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import type { EditorViewState } from "../editor-workspace";
import { createFileWriter, type FileWriter } from "../file-writer";
import { detectNewline, withNewline } from "../line-endings";
import { applyMarkdownEdit, type MarkdownEditAction } from "../markdown-edit";
import { SaveCoordinator } from "../save-coordinator";
import { useHighlightedLines, useRestoredView } from "./use-file-view";

const SAVE_DEBOUNCE_MS = 500;

export type SaveState = "clean" | "saving" | "problem";
export type SaveProblem = { refused: boolean; reason: string };

type Options = {
  path: string;
  sessionId?: string | undefined;
  projectId?: string | undefined;
  hostId?: string | undefined;
  lang: string | undefined;
  active?: TurnState | undefined;
  onSaveState?: ((state: SaveState) => void) | undefined;
  readView?: (() => EditorViewState | undefined) | undefined;
  onView?: ((view: EditorViewState) => void) | undefined;
};

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

type SaverInput = {
  editable: boolean;
  readied: FileWriter | undefined;
  writer: FileWriter;
  scope: string;
  path: string;
  owner: RefObject<DraftOwner>;
  latest: RefObject<string>;
  saveStateRef: RefObject<((state: SaveState) => void) | undefined>;
  setPending: (pending: boolean) => void;
  setProblem: (problem: SaveProblem | undefined) => void;
  discarded: number;
};

// One coordinator per file, never rebuilt by its own saves; the stash is kept from its callbacks so late answers count.
function useSaver({ editable, readied, writer, scope, path, owner, latest, saveStateRef, setPending, setProblem, discarded }: SaverInput) {
  const saverRef = useRef<SaveCoordinator | null>(null);
  useEffect(() => {
    if (!editable || readied !== writer) return;
    const saver = new SaveCoordinator({
      debounceMs: SAVE_DEBOUNCE_MS,
      persist: (text) => writer.persist(text),
      onPending: (value) => {
        setPending(value);
        saveStateRef.current?.(value ? "saving" : "clean");
      },
      onSaved: (text) => {
        setProblem(undefined);
        forgetDraft(scope, path, owner.current);
        const owed = writer.baseline;
        if (owed && latest.current !== text) rememberDraft(scope, path, { text: latest.current, baseline: owed }, owner.current);
      },
      onProblem: (outcome) => {
        const failure = { refused: outcome.status === "refused", reason: outcome.reason };
        setProblem(failure);
        const owed = writer.baseline;
        if (owed) rememberDraft(scope, path, { text: latest.current, baseline: owed, problem: failure }, owner.current);
        saveStateRef.current?.("problem");
      },
    });
    saverRef.current = saver;
    const stashed = claimDraft(scope, path, owner.current);
    if (stashed && stashed.baseline === writer.baseline) saver.change(stashed.text);
    return () => {
      saver.dispose();
      saverRef.current = null;
    };
  }, [editable, readied, writer, scope, path, saveStateRef, latest, owner, setPending, setProblem]);

  // Resume rather than rebuild: disposing flushes, which would write the discarded text back.
  useEffect(() => {
    if (discarded === 0) return;
    saverRef.current?.resume(latest.current);
  }, [discarded, latest]);
  return saverRef;
}

/** Read, highlight and autosave one workspace file against the hash it was read at. */
export function useFileEditor({ path, sessionId, projectId, hostId, lang, active, onSaveState, readView, onView }: Options) {
  const [file, setFile] = useState<WorkspaceFile>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [readied, setReadied] = useState<FileWriter>();
  const [discarded, setDiscarded] = useState(0);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SaveProblem>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Saver callbacks can answer after unmount, so they read the current parent callback through refs.
  const saveStateRef = useLatest(onSaveState);
  const readViewRef = useLatest(readView);
  const latest = useRef("");
  const owner = useRef(newDraftOwner());
  const scope = draftScope(hostId, sessionId, projectId);
  // Pinned per mount: a flush after navigating away must still reach the Mac the file was opened on.
  const api = useMemo(() => createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [hostId]);
  // Re-made per file only; the writer carries the hash across saves so they never conflict with each other.
  const writer = useMemo(
    () =>
      createFileWriter({
        send: async (text, expected) => {
          const result = sessionId
            ? await api.writeSessionFile(sessionId, path, text, expected)
            : await api.writeProjectFile(projectId!, path, text, expected);
          if (!result.written) return { written: false, refusal: result.refusal };
          setFile((known) => (known ? { ...known, ...result.file } : known));
          return { written: true, sha256: result.file.sha256 };
        },
        describe: (cause) => (cause instanceof EngineApiError ? cause.message : "The save could not be sent."),
      }),
    [api, sessionId, projectId, path],
  );

  // `discard` re-reads disk over unsaved text; otherwise the stashed draft and its baseline win.
  const load = useCallback(
    async (discard = false) => {
      if (!sessionId && !projectId) return;
      const before = writer.writes;
      try {
        const read = sessionId ? await api.sessionFile(sessionId, path) : await api.projectFile(projectId!, path);
        // A read our own write overtook is an echo of the old bytes.
        if (!discard && writer.writes !== before) return read.file;
        setFile(read.file);
        const claimed = read.file.binary ? undefined : claimDraft(scope, path, owner.current);
        if (discard) forgetDraft(scope, path, owner.current);
        const stashed = discard ? undefined : claimed;
        // A textarea normalises to LF; the writer puts the file's own endings back.
        const newline = read.file.binary ? "\n" : detectNewline(read.file.text);
        const text = read.file.binary ? undefined : (stashed?.text ?? withNewline(read.file.text, "\n"));
        const hash = read.file.binary ? undefined : (stashed?.baseline ?? read.file.sha256);
        latest.current = text ?? "";
        writer.rebase({ sha256: hash, newline });
        if (discard) setDiscarded((count) => count + 1);
        setDraft(text);
        setReadied(hash ? writer : undefined);
        setProblem(stashed?.problem);
        setPending(Boolean(stashed) && !stashed?.problem);
        saveStateRef.current?.(stashed?.problem ? "problem" : stashed ? "saving" : "clean");
        setError(undefined);
        return read.file;
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
        return undefined;
      }
    },
    [sessionId, projectId, path, scope, api, writer, saveStateRef],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  // A truncated read holds a prefix; saving it would drop the rest of the file.
  const editable = Boolean(file && !file.binary && !file.truncated && (sessionId || projectId));

  const saverRef = useSaver({ editable, readied, writer, scope, path, owner, latest, saveStateRef, setPending, setProblem, discarded });
  const { lines, coloured } = useHighlightedLines(draft, lang);
  const rememberView = useRestoredView(draft, readViewRef, onView, textareaRef, scrollerRef);

  // The only way text changes: screen, saver and stash, so an unmount mid-save loses nothing.
  const change = useCallback(
    (text: string) => {
      latest.current = text;
      setDraft(text);
      saverRef.current?.change(text);
      const owed = writer.baseline;
      if (owed) rememberDraft(scope, path, { text, baseline: owed }, owner.current);
    },
    [scope, path, writer, saverRef],
  );

  const applyEdit = useCallback(
    (action: MarkdownEditAction) => {
      const area = textareaRef.current;
      if (!area || draft === undefined) return;
      const edit = applyMarkdownEdit(draft, area.selectionStart, area.selectionEnd, action);
      change(edit.text);
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      });
    },
    [draft, change],
  );

  const flush = useCallback(() => void saverRef.current?.flush(), [saverRef]);

  return {
    file,
    error,
    draft,
    lines,
    coloured,
    editable,
    problem,
    dirty: pending || Boolean(problem),
    load,
    change,
    applyEdit,
    flush,
    rememberView,
    textareaRef,
    scrollerRef,
  };
}
