"use client";

import { useEffect, useState } from "react";
import { ArrowLeftIcon, Undo2Icon, XIcon } from "lucide-react";
import { DirectoryBrowser } from "@/features/files";
import { PaletteListPage } from "./palette-list-page";
import { useProjectPalette, type ProjectPalettePage } from "../hooks/use-project-palette";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { createEngineApi } from "@/platform/engine";
import type { NewConversationTarget, PalettePage, Registered } from "../palette-model";

const api = createEngineApi();

const PAGE_TITLES: Record<ProjectPalettePage, string> = {
  projects: "New conversation",
  sources: "Add a project",
  local: "Choose a project folder",
  "clone-url": "Clone a repository",
  "clone-parent": "Choose where to clone",
};

const PAGE_SENTENCES: Record<ProjectPalettePage, string> = {
  projects: "Choose the project this conversation belongs to.",
  sources: "Choose where the project comes from.",
  local: "Browse for the folder that holds the project.",
  "clone-url": "Enter the repository to clone.",
  "clone-parent": "Browse for the folder to clone into.",
};

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
  const palette = useProjectPalette({ open, openOn, targets, onClose, onChoose, onRegistered, onBack });
  const { page, query, notice, busy, count, index, go } = palette;

  return (
    <div className="contents" onKeyDown={palette.onKeyDown}>
      <DialogTitle className="sr-only">{PAGE_TITLES[page]}</DialogTitle>
      <DialogDescription className="sr-only">{PAGE_SENTENCES[page]}</DialogDescription>

      {page === "local" || page === "clone-parent" ? (
        <DirectoryBrowser
          {...(page === "local" && palette.startAt ? { startAt: palette.startAt } : {})}
          actionLabel={page === "local" ? "Add" : "Clone here"}
          busy={busy}
          {...(notice ? { notice } : {})}
          onBack={() => go("sources")}
          onSubmit={palette.submitFolder}
          onPickNatively={(from) =>
            palette.pickWithSystem({ title: page === "local" ? "Choose a project folder" : "Choose the folder to clone into", defaultPath: from }, palette.submitFolder)
          }
        />
      ) : page === "clone-url" ? (
        <CloneUrlPage {...(notice ? { notice } : {})} onBack={() => go("sources")} onSubmit={palette.takeCloneUrl} onChange={() => palette.setNotice(undefined)} />
      ) : (
        <PaletteListPage
          page={page}
          query={query}
          onQuery={palette.search}
          composingRef={palette.composing}
          count={count}
          at={count === 0 ? -1 : Math.min(index, count - 1)}
          targets={targets}
          matches={palette.matches}
          rows={palette.rows}
          notice={notice}
          backsTo={palette.backsTo}
          showBack={page === "sources" || Boolean(onBack)}
          onBack={palette.goBack}
          onChoose={palette.choose}
          onAdd={() => go("sources")}
          onPickSource={palette.pickSource}
          onHover={palette.setIndex}
        />
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
