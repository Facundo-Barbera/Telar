"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, CornerDownLeftIcon, EyeIcon, EyeOffIcon, FolderIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
import type { DirectoryEntry, DirectoryListing } from "@telar/engine-client";
import {
  clampIndex,
  directoryField,
  directoryKey,
  rememberedDirectoryKey,
  type DirectoryBrowserState,
} from "../directory-keys";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";
import { workspaceOpener } from "../workspace-open";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** Must be stable across renders: it is a dependency of the fetching effect. */
export type DirectoryLister = (input: { path?: string; hidden?: boolean; nearest?: boolean }) => Promise<DirectoryListing>;

const engineLister: DirectoryLister = (input) => api.fsDirs(input);

function remembered(hostId: string | undefined): string | undefined {
  try {
    return window.localStorage.getItem(rememberedDirectoryKey(hostId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(hostId: string | undefined, path: string): void {
  try {
    window.localStorage.setItem(rememberedDirectoryKey(hostId), path);
  } catch {
    return;
  }
}

export function DirectoryBrowser({
  actionLabel,
  onSubmit,
  onBack,
  onFallback,
  busy,
  notice,
  hostId,
  startAt,
  list = engineLister,
}: {
  actionLabel: string;
  onSubmit: (path: string) => void;
  onBack: () => void;
  /** Offered only when the engine could not be reached. */
  onFallback?: () => void;
  busy?: boolean;
  notice?: string;
  hostId?: string;
  /** A pasted path; if it is a file or gone, its nearest existing folder opens instead. */
  startAt?: string;
  list?: DirectoryLister;
}) {
  const [target, setTarget] = useState<string | undefined>(() =>
    startAt ?? (typeof window === "undefined" ? undefined : remembered(hostId)),
  );
  const [nearest, setNearest] = useState(Boolean(startAt));
  const [aside, setAside] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  const [field, setField] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  // A remembered directory that has gone falls back to home, once.
  const fellBack = useRef(false);
  const rows = useRef<HTMLDivElement>(null);

  // No synchronous setState here; whatever changes the target turns the spinner on.
  useEffect(() => {
    let live = true;
    void list({ ...(target ? { path: target } : {}), ...(hidden ? { hidden: true } : {}), ...(nearest && target ? { nearest: true } : {}) })
      .then((answer) => {
        if (!live) return;
        if (answer.missing) setAside(`Nothing to open at ${answer.missing}, so this is the nearest folder that exists.`);
        setListing(answer);
        setField(directoryField(answer.path, answer.home));
        setIndex(0);
        setError(undefined);
        setUnreachable(false);
        setLoading(false);
        remember(hostId, answer.path);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLoading(false);
        const code = cause instanceof EngineApiError ? cause.code : undefined;
        if (target && !fellBack.current && (code === "not_found" || code === "invalid_request")) {
          fellBack.current = true;
          if (nearest && cause instanceof EngineApiError) setAside(`${cause.message} Showing home instead.`);
          setNearest(false);
          setLoading(true);
          setTarget(undefined);
          return;
        }
        setUnreachable(code === "engine_unavailable" || code === "cockpit_unauthorized");
        setError(cause instanceof EngineApiError ? cause.message : "That folder could not be listed.");
      });
    return () => {
      live = false;
    };
  }, [list, target, hidden, nearest, hostId]);

  const entries = useMemo(() => listing?.dirs ?? [], [listing]);
  const at = clampIndex(index, entries.length);

  const state: DirectoryBrowserState = useMemo(
    () => ({
      field,
      path: listing?.path ?? "",
      parent: listing?.parent ?? null,
      home: listing?.home ?? "",
      entries,
      index: at,
      hidden,
    }),
    [field, listing, entries, at, hidden],
  );

  useEffect(() => {
    if (at < 0) return;
    rows.current?.querySelector(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const open = (path: string) => {
    setError(undefined);
    setAside(undefined);
    setNearest(false);
    setLoading(true);
    setTarget(path);
  };

  const showHidden = (next: boolean) => {
    setLoading(true);
    setHidden(next);
  };

  const submit = () => {
    if (busy || !listing) return;
    onSubmit(listing.path);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const action = directoryKey(state, { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey });
    if (action.type === "none") {
      if (event.key === "Tab" && !event.shiftKey) event.preventDefault();
      return;
    }
    event.preventDefault();
    if (action.type === "move") setIndex(action.index);
    else if (action.type === "open") open(action.path);
    else if (action.type === "complete") setField(action.field);
    else if (action.type === "hidden") showHidden(action.hidden);
    else if (action.type === "submit") submit();
  };

  // Finder is on this Mac; revealing a remote host's path could open the wrong folder.
  const bridge = typeof window === "undefined" ? undefined : workspaceOpener();
  const here = !hostId || hostId === LOCAL_HOST_ID;
  const canReveal = Boolean(bridge?.reveal) && here && Boolean(listing);

  return (
    /* Keys are caught for the whole page so ⌘Enter still works after a row takes focus. */
    <div className="contents" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          onClick={onBack}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <input
          autoFocus
          value={field}
          onChange={(event) => {
            setField(event.target.value);
            setError(undefined);
          }}
          placeholder="~/"
          aria-label="Folder path"
          role="combobox"
          aria-expanded={entries.length > 0}
          aria-controls="directory-browser-entries"
          aria-activedescendant={at >= 0 ? `directory-browser-entry-${at}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label={hidden ? "Hide dotfolders" : "Show dotfolders"}
          title={`${hidden ? "Hide" : "Show"} dotfolders (⌘.)`}
          aria-pressed={hidden}
          onClick={() => showHidden(!hidden)}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hidden ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      </div>

      {/* Mounted volumes the engine already allows, made reachable; shown only when there is more than home. */}
      {(listing?.roots?.length ?? 0) > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
          {listing?.roots.map((root) => (
            <button
              key={root.path}
              type="button"
              onClick={() => open(root.path)}
              aria-current={listing.path === root.path}
              className="rounded-sm px-1.5 py-0.5 text-2xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:text-foreground"
            >
              {root.name}
            </button>
          ))}
        </div>
      )}

      <div ref={rows} id="directory-browser-entries" role="listbox" aria-label="Directories" className="max-h-80 overflow-y-auto p-1.5">
        <p aria-hidden className="px-2 pt-1 pb-1.5 text-2xs font-medium text-muted-foreground">
          Directories
        </p>
        {loading && entries.length === 0 && (
          <p className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Reading that folder…
          </p>
        )}
        {!loading && entries.length === 0 && !error && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {hidden ? "Nothing but files in here." : "No folders in here — ⌘. shows dotfolders."}
          </p>
        )}
        {entries.map((entry, row) => (
          <DirectoryRow
            key={entry.path}
            row={row}
            on={row === at}
            entry={entry}
            onHover={() => setIndex(row)}
            onPick={() => open(entry.path)}
          />
        ))}
        {listing?.truncated && (
          <p className="px-2 py-2 text-2xs text-muted-foreground">
            Only the first folders are listed. Type a path to go straight to one.
          </p>
        )}
        {listing?.gitPartial && (
          <p className="px-2 py-2 text-2xs text-muted-foreground">
            This folder was slow to read, so not every repository is marked. Open one to check it.
          </p>
        )}
      </div>

      {(error ?? notice ?? aside) && (
        <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
          {error ?? notice ?? aside}
        </p>
      )}

      {unreachable && onFallback && (
        <div className="border-t px-3 py-2">
          <button type="button" onClick={onFallback} className="rounded-sm text-2xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Choose a folder with the system picker instead
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <kbd className="font-sans">↑↓</kbd> Navigate
        </span>
        <span>
          <kbd className="font-sans">Enter</kbd> Open
        </span>
        <span>
          <kbd className="font-sans">Backspace</kbd> Up
        </span>
        <span className="flex-1" />
        {canReveal && listing && bridge?.reveal && (
          <button
            type="button"
            onClick={() => void bridge.reveal(listing.path)}
            className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open in Finder
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={Boolean(busy) || !listing}
          className={cn(
            "flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:opacity-60",
          )}
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <CornerDownLeftIcon className="size-3" />}
          {actionLabel}
          <kbd className="font-sans opacity-70">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}

function DirectoryRow({
  row,
  on,
  entry,
  onHover,
  onPick,
}: {
  row: number;
  on: boolean;
  entry: DirectoryEntry;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      id={`directory-browser-entry-${row}`}
      data-row={row}
      type="button"
      role="option"
      aria-selected={on}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        entry.hidden && "opacity-70",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <FolderIcon className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{entry.name}</span>
      {entry.git && <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Git repository" />}
    </button>
  );
}
