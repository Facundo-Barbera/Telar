"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  FolderPlusIcon,
  SearchIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { DirectoryBrowser } from "@/features/files";
import { ProjectAvatar } from "./project-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { claimChords } from "@/features/commands";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { announceProjectsChanged } from "../projects";
import { cn } from "@/ui/utils";
import {
  cloneRequest,
  folderName,
  matchTargets,
  paletteBack,
  pathRequest,
  QUICK_PICK_LIMIT,
  sourceRows,
  targetPlace,
  type NewConversationTarget,
  type PalettePage,
  type ProjectSource,
  type Registered,
} from "../palette-model";

const api = createEngineApi();

type Page = PalettePage | "local" | "clone-url" | "clone-parent";

const PAGE_TITLES: Record<Page, string> = {
  projects: "New conversation",
  sources: "Add a project",
  local: "Choose a project folder",
  "clone-url": "Clone a repository",
  "clone-parent": "Choose where to clone",
};

const PAGE_SENTENCES: Record<Page, string> = {
  projects: "Choose the project this conversation belongs to.",
  sources: "Choose where the project comes from.",
  local: "Browse for the folder that holds the project.",
  "clone-url": "Enter the repository to clone.",
  "clone-parent": "Browse for the folder to clone into.",
};


const QUICK_PICK_CHORDS = Array.from({ length: QUICK_PICK_LIMIT }, (_, index) => `CommandOrControl+${index + 1}`);


export function ProjectPalette({
  open,
  page = "projects",
  onOpenChange,
  targets,
  onChoose,
  onRegistered,
}: {
  open: boolean;
  page?: PalettePage;
  onOpenChange: (open: boolean) => void;
  targets: readonly NewConversationTarget[];
  onChoose: (target: NewConversationTarget) => void;
  onRegistered: () => void;
}) {
  const [toast, setToast] = useState<Registered>();

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="top-[18%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg">
          <ProjectPalettePages
            open={open}
            page={page}
            targets={targets}
            onChoose={onChoose}
            onClose={() => onOpenChange(false)}
            onRegistered={(registered) => {
              setToast(registered);
              onRegistered();
            }}
          />
        </DialogContent>
      </Dialog>

      <RegisteredToast toast={toast} onDismiss={() => setToast(undefined)} onChanged={onRegistered} />
    </>
  );
}

export function ProjectPalettePages({
  open = true,
  page: openOn,
  onClose,
  targets,
  onChoose,
  onRegistered,
  onBack,
}: {
  open?: boolean;
  page: PalettePage;
  onClose: () => void;
  targets: readonly NewConversationTarget[];
  onChoose: (target: NewConversationTarget) => void;
  onRegistered: (registered: Registered) => void;
  onBack?: () => void;
}) {
  const [page, setPage] = useState<Page>(openOn);
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cloneUrl, setCloneUrl] = useState<string>();
  const [startAt, setStartAt] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const matches = useMemo(() => matchTargets(targets, query), [targets, query]);
  const rows = useMemo(() => sourceRows(query), [query]);
  const count = page === "projects" ? matches.length + 1 : rows.length;

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPage(openOn);
      setQuery("");
      setIndex(0);
      setBusy(false);
      setNotice(undefined);
      setCloneUrl(undefined);
      setStartAt(undefined);
    }
  }

  const listPage = page === "projects" || page === "sources";
  useEffect(() => {
    if (!open || !listPage) return undefined;
    return claimChords(QUICK_PICK_CHORDS);
  }, [open, listPage]);

  const go = (next: Page) => {
    setPage(next);
    setQuery("");
    setIndex(0);
    setNotice(undefined);
  };

  const backRoot: PalettePage = onBack ? openOn : "projects";
  const list: PalettePage = page === "sources" ? "sources" : "projects";
  const backsTo = paletteBack(list, "", backRoot);
  const goBack = () => {
    if (backsTo === "projects") go("projects");
    else onBack?.();
  };

  const choose = (target: NewConversationTarget | undefined) => {
    if (!target) return;
    onClose();
    onChoose(target);
  };

  const settle = async (project: { id: string; name: string }) => {
    announceProjectsChanged();
    let ignored = true;
    try {
      await api.projectGitignore(project.id);
    } catch {
      ignored = false;
    }
    onClose();
    onRegistered({ projectId: project.id, name: project.name, ignored });
  };

  const failed = (cause: unknown) => setNotice(cause instanceof EngineApiError ? cause.message : String(cause));

  const addLocalFolder = async (root: string) => {
    setNotice(undefined);
    setBusy(true);
    try {
      await settle((await api.registerProject({ name: folderName(root), root })).project);
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };

  const cloneInto = async (parent: string) => {
    if (!cloneUrl) return;
    setNotice(undefined);
    setBusy(true);
    try {
      await settle((await api.cloneProject({ url: cloneUrl, parent })).project);
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };

  const pickWithSystem = (title: string, then: (path: string) => void) => {
    void chooseDirectory({ title }).then((chosen) => {
      if ("cancelled" in chosen) return;
      if ("unavailable" in chosen) {
        setNotice(chosen.unavailable);
        return;
      }
      then(chosen.path);
    });
  };

  const pickSource = (source: ProjectSource | undefined) => {
    if (!source || busy) return;
    if (source.setupRequired) {
      setNotice(`${source.title} is not set up yet. Clone it yourself and add it as a local folder.`);
      return;
    }
    if (!source.clones) {
      setStartAt(pathRequest(query));
      go("local");
      return;
    }
    const clone = cloneRequest(query);
    setCloneUrl(clone?.url);
    go(clone ? "clone-parent" : "clone-url");
  };

  const takeCloneUrl = (typed: string) => {
    const clone = cloneRequest(typed);
    if (!clone) {
      setNotice("That is not a clone URL. Paste an https, ssh or git URL — or owner/repo.");
      return;
    }
    setCloneUrl(clone.url);
    go("clone-parent");
  };

  const take = (at: number) => {
    if (page === "sources") {
      pickSource(rows[at]);
      return;
    }
    if (at >= matches.length) go("sources");
    else choose(matches[at]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (page !== "projects" && page !== "sources") return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      take(Number(event.key) - 1);
      return;
    }
    if (event.key === "Backspace" && paletteBack(list, query, backRoot)) {
      event.preventDefault();
      goBack();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((current) => (current + delta + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      take(index);
    }
  };

  const at = count === 0 ? -1 : Math.min(index, count - 1);

  return (
    <div className="contents" onKeyDown={onKeyDown}>
      <DialogTitle className="sr-only">{PAGE_TITLES[page]}</DialogTitle>
      <DialogDescription className="sr-only">{PAGE_SENTENCES[page]}</DialogDescription>

      {page === "local" || page === "clone-parent" ? (
            <DirectoryBrowser
              {...(page === "local" && startAt ? { startAt } : {})}
              actionLabel={page === "local" ? "Add" : "Clone here"}
              busy={busy}
              {...(notice ? { notice } : {})}
              onBack={() => go("sources")}
              onSubmit={(root) => void (page === "local" ? addLocalFolder(root) : cloneInto(root))}
              onFallback={() =>
                pickWithSystem(
                  page === "local" ? "Choose a project folder for Telar" : "Choose the folder to clone into",
                  (root) => void (page === "local" ? addLocalFolder(root) : cloneInto(root)),
                )
              }
            />
          ) : page === "clone-url" ? (
            <CloneUrlPage
              {...(notice ? { notice } : {})}
              onBack={() => go("sources")}
              onSubmit={takeCloneUrl}
              onChange={() => setNotice(undefined)}
            />
          ) : (
            <>
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            {page === "sources" || onBack ? (
              <button
                type="button"
                aria-label={backsTo === "projects" ? "Back to projects" : "Back"}
                title={backsTo === "projects" ? "Back to projects" : "Back"}
                onClick={goBack}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            ) : (
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
                setNotice(undefined);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              placeholder={page === "sources" ? "Search sources, or paste a URL or folder path" : "Search projects"}
              aria-label={page === "sources" ? "Search sources, or paste a URL or folder path" : "Search projects"}
              role="combobox"
              aria-expanded={count > 0}
              aria-controls="project-palette-results"
              aria-activedescendant={at >= 0 ? `project-palette-${page}-${at}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div
            id="project-palette-results"
            role="listbox"
            aria-label={page === "sources" ? "Sources" : "Projects"}
            className="max-h-80 overflow-y-auto p-1.5"
          >
            <p aria-hidden className="px-2 pt-1 pb-1.5 text-2xs font-medium text-muted-foreground">
              {page === "sources" ? "Sources" : "Projects"}
            </p>
            {page === "projects" ? (
              <>
                {matches.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {targets.length === 0 ? "No projects registered yet." : "No project matches that."}
                  </p>
                )}
                {matches.map((target, row) => (
                  <PaletteRow
                    key={`${target.hostId ?? "local"}:${target.id}`}
                    id={`project-palette-projects-${row}`}
                    on={row === at}
                    onPick={() => choose(target)}
                    onHover={() => setIndex(row)}
                    glyph={
                      <ProjectAvatar
                        name={target.name}
                        {...(target.hostId ? {} : { projectId: target.id })}
                        {...(target.icon ? { icon: target.icon } : {})}
                        {...(target.iconName ? { iconName: target.iconName } : {})}
                        size={16}
                      />
                    }
                    title={target.name}
                    hint={targetPlace(target)}
                    mono
                    {...(row < QUICK_PICK_LIMIT ? { key9: row + 1 } : {})}
                  />
                ))}
                <PaletteRow
                  id={`project-palette-projects-${matches.length}`}
                  on={at === matches.length}
                  onPick={() => go("sources")}
                  onHover={() => setIndex(matches.length)}
                  glyph={<FolderPlusIcon className="size-4 text-muted-foreground" />}
                  title="Add a project…"
                  hint="A folder on this Mac, or a repository to clone"
                />
              </>
            ) : (
              <>
                {rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No source matches that.</p>}
                {rows.map((source, row) => (
                  <PaletteRow
                    key={source.id}
                    id={`project-palette-sources-${row}`}
                    on={row === at}
                    dim={Boolean(source.setupRequired)}
                    onPick={() => pickSource(source)}
                    onHover={() => setIndex(row)}
                    glyph={<source.icon className="size-4 text-muted-foreground" />}
                    title={source.title}
                    hint={source.hint}
                    mono={source.hint.startsWith("Clone ")}
                    badge={
                      source.setupRequired ? (
                        <span className="shrink-0 rounded border px-1.5 py-0.5 text-3xs text-muted-foreground">Setup Required</span>
                      ) : undefined
                    }
                  />
                ))}
              </>
            )}
          </div>

          {notice && (
            <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
              {notice}
            </p>
          )}

          <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
            <span>
              <kbd className="font-sans">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="font-sans">Enter</kbd> Select
            </span>
            {(page === "sources" || onBack) && (
              <span>
                <kbd className="font-sans">Backspace</kbd> Back
              </span>
            )}
            <span>
              <kbd className="font-sans">Esc</kbd> Close
            </span>
          </div>
            </>
          )}
    </div>
  );
}

function CloneUrlPage({
  notice,
  onBack,
  onSubmit,
  onChange,
}: {
  notice?: string;
  onBack: () => void;
  onSubmit: (url: string) => void;
  onChange: () => void;
}) {
  const [url, setUrl] = useState("");

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          aria-label="Back to sources"
          title="Back to sources"
          onClick={onBack}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <input
          autoFocus
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            onChange();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            onSubmit(url);
          }}
          placeholder="https://github.com/owner/repo.git"
          aria-label="Git clone URL"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        Enter a Git clone URL and press Enter to continue
      </p>

      {notice && (
        <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <kbd className="font-sans">Enter</kbd> Continue
        </span>
        <span>
          <kbd className="font-sans">Esc</kbd> Close
        </span>
      </div>
    </>
  );
}

export function PaletteRow({
  id,
  on,
  dim,
  onPick,
  onHover,
  glyph,
  title,
  hint,
  mono,
  badge,
  key9,
  trailing,
}: {
  id: string;
  on: boolean;
  dim?: boolean;
  onPick: () => void;
  onHover: () => void;
  glyph: React.ReactNode;
  title: string;
  hint?: string;
  mono?: boolean;
  badge?: React.ReactNode;
  key9?: number;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={on}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        dim && "opacity-60",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{title}</span>
          {badge}
        </span>
        {hint && (
          <span className={cn("block truncate text-2xs text-muted-foreground", mono && "font-mono")}>{hint}</span>
        )}
      </span>
      {key9 !== undefined && <kbd className="shrink-0 font-sans text-3xs text-muted-foreground/60">⌘{key9}</kbd>}
      {trailing}
    </button>
  );
}

export function RegisteredToast({
  toast,
  onDismiss,
  onChanged,
}: {
  toast: { projectId: string; name: string; ignored: boolean } | undefined;
  onDismiss: () => void;
  onChanged: () => void;
}) {
  const [undone, setUndone] = useState<string>();
  const key = toast?.projectId;

  useEffect(() => {
    if (!key) return undefined;
    const timer = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(timer);
  }, [key, onDismiss]);

  if (!toast) return null;
  const reversed = undone === toast.projectId;

  const undo = () => {
    setUndone(toast.projectId);
    void api
      .undoProjectGitignore(toast.projectId)
      .then(() => onChanged())
      .catch(() => setUndone(undefined));
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-3"
    >
      <span className="min-w-0 flex-1 text-xs leading-snug">
        <span className="block font-medium">{toast.name} was added.</span>
        <span className="mt-0.5 block text-muted-foreground">
          {!toast.ignored
            ? "Telar's files could not be added to its .gitignore."
            : reversed
              ? "Those rules were taken back out of its .gitignore."
              : "Telar's files are ignored in its .gitignore."}
        </span>
      </span>
      {toast.ignored && !reversed && (
        <button
          type="button"
          onClick={undo}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Undo2Icon className="size-3.5" />
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
