"use client";

// Ported from the frozen app's components/projects/register-dialog.tsx, and both
// of the things this side had dropped are back.
//
// THE BROWSE BUTTON should never have gone: an absolute path is the one thing a web
// page cannot produce, so without a picker the only way in was typing
// `/Users/you/code/thing` and finding out about the typo from the engine's refusal.
// It goes through the desktop shell's native dialog where there is one and the
// adapter's own picker otherwise — see lib/choose-directory.ts.
//
// THE GITIGNORE TOGGLE is back with an honest label. vNext writes NOTHING into a
// checkout — every engine write lands under TELAR_HOME, worktrees included — so
// these rules are defensive rather than necessary, and the checkbox says which
// rules it will add rather than claiming to tidy up after something. It is a
// SECOND request after the project registers, on purpose: a repository that could
// not be written to still gets registered, and the failure gets its own sentence
// instead of losing the project.

import { useState } from "react";
import { FolderOpenIcon, FolderPlusIcon, Loader2Icon, XIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const api = createVNextApi();

function Field({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function RegisterProjectDialog({
  onRegistered,
  compact = false,
}: {
  onRegistered: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [ignore, setIgnore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basename =
    root
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setRoot("");
      setName("");
      setError(null);
      setSubmitting(false);
      setBrowsing(false);
      setIgnore(false);
    }
  };

  /**
   * Open the OS picker and take the path it returns.
   *
   * CANCELLING CLEARS THE ERROR AND CHANGES NOTHING ELSE — it is not a failure,
   * and a path already typed must survive somebody opening the picker and thinking
   * better of it. Only a picker that genuinely cannot run says anything.
   */
  const browse = async () => {
    setBrowsing(true);
    setError(null);
    try {
      const chosen = await chooseDirectory({ title: "Choose a project folder for Telar" });
      if ("path" in chosen) setRoot(chosen.path);
      else if ("unavailable" in chosen) setError(`${chosen.unavailable} Type the absolute path instead.`);
    } finally {
      setBrowsing(false);
    }
  };

  const submit = async () => {
    const trimmedRoot = root.trim();
    if (!trimmedRoot) {
      setError("Enter the absolute path to a repository.");
      return;
    }
    setSubmitting(true);
    setError(null);
    let project;
    try {
      project = (await api.registerProject({ name: name.trim() || basename, root: trimmedRoot })).project;
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : String(cause));
      setSubmitting(false);
      return;
    }
    /**
     * A SECOND REQUEST, AND ITS FAILURE IS NOT THE PROJECT'S.
     *
     * The project is registered by the time this runs, so a `.gitignore` that could
     * not be written — a read-only checkout, a permission problem — reports itself
     * and leaves the project in place. Folding the two into one call would mean
     * losing a perfectly good registration to a file write.
     */
    if (ignore) {
      try {
        await api.projectGitignore(project.id);
      } catch (cause) {
        setError(
          `${project.name} was registered, but its .gitignore could not be written: ${cause instanceof VNextApiError ? cause.message : String(cause)}`,
        );
        setSubmitting(false);
        onRegistered();
        return;
      }
    }
    handleOpenChange(false);
    onRegistered();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            size={compact ? "icon-sm" : "sm"}
            variant={compact ? "ghost" : "default"}
            aria-label={compact ? "New project" : undefined}
            title={compact ? "New project" : undefined}
          />
        }
      >
        <FolderPlusIcon />
        {!compact && "Register project"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register a project</DialogTitle>
          {/* This used to promise "nothing is written into it", which the toggle
              below now makes conditionally false. A description that a control on
              the same screen contradicts is worse than a longer one. */}
          <DialogDescription>Point the engine at a repo on this machine. Nothing is written into it unless you ask below.</DialogDescription>
        </DialogHeader>

        <form
          className="grid max-h-[60dvh] gap-4 overflow-y-auto pr-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submitting) void submit();
          }}
        >
          {/* THE FIELD STAYS EDITABLE beside the button. A picker is faster for
              a folder you have to go and find; typing is faster for one you can
              name, and pasting is faster than both. Replacing the field with a
              button would take the third away. */}
          <Field htmlFor="project-root" label="Repository path" hint="Absolute path to the repo root on this machine.">
            <div className="flex items-center gap-1.5">
              <Input
                id="project-root"
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder="/Users/you/code/my-repo"
                className="min-w-0 flex-1 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="button" variant="outline" onClick={() => void browse()} disabled={browsing} className="shrink-0">
                {browsing ? <Loader2Icon className="animate-spin" /> : <FolderOpenIcon />}
                Browse…
              </Button>
            </div>
          </Field>

          <Field
            htmlFor="project-name"
            label="Project name (optional)"
            hint={basename ? `Defaults to the folder name: ${basename}` : "Defaults to the repository folder name."}
          >
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={basename || "project-name"}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {/**
           * NAMES THE RULES IT WILL WRITE, rather than saying "add Telar's files".
           * The honest version of this control is the one that shows the two lines
           * going into somebody's repository — and it is off by default, because
           * vNext creates none of these files and a checkbox that writes into a
           * checkout should be a decision rather than a default.
           */}
          <label htmlFor="project-gitignore" className="flex cursor-pointer items-start gap-2.5">
            <Switch id="project-gitignore" checked={ignore} onCheckedChange={setIgnore} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">Ignore Telar&apos;s files in this repo</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                Appends <span className="font-mono">telar.yaml</span>, <span className="font-mono">.telar/</span> and{" "}
                <span className="font-mono">.telar-worktrees/</span> to <span className="font-mono">.gitignore</span>, skipping any rule that is
                already there. vNext writes none of these into a checkout — worktrees live outside it — so this is a precaution, not a cleanup.
              </span>
            </span>
          </label>

          {error && (
            <Alert variant="destructive">
              <XIcon />
              <AlertTitle>Couldn&apos;t register</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !root.trim()}>
            {submitting && <Loader2Icon className="animate-spin" />}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
