"use client";

// Ported from the frozen app's components/projects/register-dialog.tsx.
//
// TWO FIELDS FEWER. The donor also offered a native "Browse…" folder picker
// (POST /api/browse, an Electron main-process dialog) and a toggle that wrote
// `telar.yaml` and `.telar` into the repo's .gitignore. Neither exists on this
// side: the vNext engine registers a project by (name, root) and writes nothing
// into the repository, so there is no manifest to keep out of Git.

import { useState } from "react";
import { FolderPlusIcon, Loader2Icon, XIcon } from "lucide-react";
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
    try {
      await api.registerProject({ name: name.trim() || basename, root: trimmedRoot });
      handleOpenChange(false);
      onRegistered();
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause.message : String(cause));
      setSubmitting(false);
    }
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
          <DialogDescription>Point the engine at a repo on this machine. Nothing is written into it.</DialogDescription>
        </DialogHeader>

        <form
          className="grid max-h-[60dvh] gap-4 overflow-y-auto pr-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submitting) void submit();
          }}
        >
          <Field htmlFor="project-root" label="Repository path" hint="Absolute path to the repo root on this machine.">
            <Input
              id="project-root"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="/Users/you/code/my-repo"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
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
