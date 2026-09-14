"use client";

/**
 * BROWSING FOR A FOLDER WITHOUT LEAVING THE PALETTE.
 *
 * IT REPLACES A NATIVE DIALOG, and that is the whole argument. Add project used
 * to call Electron's `dialog.showOpenDialog` (lib/choose-directory.ts): a sheet
 * that covers the palette you were half-way through, with none of its keyboard,
 * and — from a browser tab or a paired Mac — a window that opens on a machine
 * nobody is looking at. T3 Code browses in the palette instead, and every part
 * of that is reachable by the keyboard alone.
 *
 * THE LISTING IS THE ENGINE'S (`/api/fs/dirs` → `fs-dirs.ts`), so on a remote
 * screen this lists the PAIRED MAC's disk: `createEngineApi()`'s default fetcher
 * follows the address bar, and `/hosts/:id/…` routes the read over there. That
 * is the thing a native dialog could never do, and the reason the last
 * directory is remembered per host rather than once.
 *
 * THE KEYBOARD IS IN `lib/directory-browser.ts`, pure. This file is the fetch,
 * the rows and the two decisions that need a browser: what localStorage
 * remembered, and whether the desktop shell is there to open Finder.
 *
 * WHEN THE ENGINE IS UNREACHABLE IT SAYS SO AND OFFERS THE OLD DOOR. A browser
 * whose listing never arrives is a dead end, and `chooseDirectory` still works
 * in the desktop shell without the engine — so the fallback is offered by name
 * rather than left as an empty list.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, CornerDownLeftIcon, EyeIcon, EyeOffIcon, FolderIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
// Type-only: `lib/fs-dirs.ts` is the route's own module and reads the
// filesystem, so this must never become a value import.
import type { DirectoryEntry, DirectoryListing } from "@/lib/fs-dirs";
import {
  clampIndex,
  directoryField,
  directoryKey,
  rememberedDirectoryKey,
  type DirectoryBrowserState,
} from "@/lib/directory-browser";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";
import { workspaceOpener } from "@/lib/workspace-open";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/**
 * The one read this component makes, injectable so the tests need no server.
 *
 * IT MUST BE STABLE across renders — it is a dependency of the effect that
 * fetches, so a fresh closure on every render is a fetch on every render. The
 * default below is module-level for exactly that reason.
 */
export type DirectoryLister = (input: { path?: string; hidden?: boolean }) => Promise<DirectoryListing>;

const engineLister: DirectoryLister = (input) => api.fsDirs(input);

/** What localStorage last held for this host, if anything readable. Private
 *  browsing and a disabled store both throw on access, and neither is a
 *  reason to fail to draw a browser. */
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
    // Nothing to do and nothing to say: the browser still works, it just opens
    // at home next time.
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
  list = engineLister,
}: {
  /** "Add" for a local folder, "Clone here" for a clone parent — the button
   *  says what pressing it does, not what kind of thing is selected. */
  actionLabel: string;
  onSubmit: (path: string) => void;
  onBack: () => void;
  /** Offer the native picker instead. Shown only when the engine could not be
   *  reached, which is the one case this browser cannot recover from. */
  onFallback?: () => void;
  /** The caller is registering or cloning; the button says so and stops taking
   *  presses. */
  busy?: boolean;
  /** The caller's own sentence — a clone that failed, a root the engine
   *  refused. Shown under the list, beside this component's own. */
  notice?: string;
  hostId?: string;
  list?: DirectoryLister;
}) {
  /** The directory to list; `undefined` asks the engine for home. Starts at
   *  whatever this host was last browsing. */
  const [target, setTarget] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : remembered(hostId),
  );
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  const [field, setField] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  /** A remembered directory that has since been deleted must not be a dead
   *  browser, so its first failure falls back to home — once. */
  const fellBack = useRef(false);
  const rows = useRef<HTMLDivElement>(null);

  /**
   * THE FETCH SETS NO STATE SYNCHRONOUSLY, which is this app's lint rule and a
   * real one: a `setLoading(true)` in this body would cascade a second render
   * on every listing. The spinner is turned on by whatever CHANGED the target
   * (`open`, `showHidden`, and the initial state), which is also where the
   * reader's gesture actually was.
   */
  useEffect(() => {
    let live = true;
    void list({ ...(target ? { path: target } : {}), ...(hidden ? { hidden: true } : {}) })
      .then((answer) => {
        if (!live) return;
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
  }, [list, target, hidden, hostId]);

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

  /** Scrolling the highlight into view is the only thing the arrows cannot do
   *  themselves — a list of thirty folders is taller than the panel. */
  useEffect(() => {
    if (at < 0) return;
    rows.current?.querySelector(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const open = (path: string) => {
    setError(undefined);
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
    // An IME's own Enter commits a candidate; it is not a choice — the same
    // guard the palette's field carries.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const action = directoryKey(state, { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey });
    if (action.type === "none") {
      // Tab and Backspace only reach the input when this said nothing, so an
      // unhandled Tab still leaves the field the way it always did.
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

  /** Finder is on THIS Mac, so a remote host's path is refused by name rather
   *  than revealed — two machines with the same layout would otherwise open
   *  the WRONG folder. The same rule `workspace-open.ts` states. */
  const bridge = typeof window === "undefined" ? undefined : workspaceOpener();
  const here = !hostId || hostId === LOCAL_HOST_ID;
  const canReveal = Boolean(bridge?.reveal) && here && Boolean(listing);

  return (
    /* `display: contents` — the keys are caught for the WHOLE page, not just
       the field, because clicking a row moves focus to that row's button and
       ⌘Enter has to keep working from there. The wrapper takes no space, so
       the dialog's own layout is unchanged. */
    <div className="contents" onKeyDown={onKeyDown}>
      {/* THE SAME HEADER THE PALETTE'S OTHER PAGES WEAR — back arrow, then the
          field — so arriving here does not feel like a different dialog. */}
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
        {/* `hidden` is "dotfolders are SHOWN" — the engine's own word for the
            query — so the button offers the other state. */}
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
      </div>

      {(error ?? notice) && (
        <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
          {error ?? notice}
        </p>
      )}

      {unreachable && onFallback && (
        <div className="border-t px-3 py-2">
          <button type="button" onClick={onFallback} className="rounded-sm text-2xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Choose a folder with the system picker instead
          </button>
        </div>
      )}

      {/* THE LEGEND IS THE FEATURE, as on the palette's other pages: ⌘Enter is
          not a key anybody guesses, and it is the one that finishes the job. */}
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
        {/* A SECONDARY LINK, never a button beside the primary one: opening
            Finder is the rare case, and it does not choose anything. */}
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

/** One folder: a glyph, its name, and a branch mark when it is a checkout —
 *  which is what makes three repositories findable in a list of thirty. */
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
