"use client";

/**
 * REMOVE A PROJECT FROM TELAR — the inverse of the register dialog, and it
 * says so in exactly those words.
 *
 * THE WHOLE DESIGN IS THE CONFIRMATION COPY. "Remove project" reads, to a
 * reasonable person, like it might delete the repository — so the dialog does
 * not summarise, it ENUMERATES: what stays (everything on disk) and what goes
 * (one row in Telar's registry). A confirmation that only says "are you sure?"
 * is asking somebody to guess at the blast radius, which for a destructive-
 * sounding verb on a folder full of work is not a fair question.
 *
 * IT LIVES UNDER "Project", beside the name, the checkout and the id it is
 * about to forget, rather than in a red "danger zone" of its own. There is one
 * such action; a zone built for it would be a section with a single row and a
 * colour promising more drama than a registry write deserves.
 *
 * THE ENGINE OWNS THE REFUSAL. A project with a session mid-turn answers 409
 * and this shows the sentence it sent — the surface never decides for itself
 * that removing is safe, and never stops somebody's work to make it so.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, XIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { announceProjectsChanged } from "@/lib/projects";
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
} from "@/components/ui/dialog";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

export function RemoveProjectSection({ project }: { project?: Project }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setError(null);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await api.unregisterProject(project.id);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause.message : "Could not remove this project.");
      setBusy(false);
      return;
    }
    // The registry changed, so every mounted list re-reads the engine's own
    // answer — see lib/projects.ts. Then leave: this page is now about a
    // project id that no longer resolves, and staying would render its own
    // "Not registered" notice at somebody who just pressed the button.
    announceProjectsChanged();
    handleOpenChange(false);
    router.push("/");
  };

  return (
    <SettingsGroup
      title="Remove from Telar"
      description="Take this project off Telar's registry. Nothing in the repository is deleted."
    >
      <Row
        label="Remove project from Telar"
        hint="Telar forgets where this project is. The folder, its Git history and its worktrees stay exactly as they are."
        control={
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={!project} onClick={() => handleOpenChange(true)}>
            Remove…
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Remove {project?.name ?? "this project"} from Telar?</DialogTitle>
            <DialogDescription>
              This removes one entry from Telar&apos;s project registry. It does not delete anything on disk.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 text-xs">
            <div>
              <p className="font-medium text-foreground">Kept, untouched</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                <li>
                  The repository at <span className="font-mono break-all">{project?.root ?? "—"}</span>, including every uncommitted change
                </li>
                <li>Its Git history, branches and any worktrees Telar cut from it</li>
                <li>The full history of every session that ran on it</li>
                <li>Those sessions&apos; browser profiles, logins and cookies</li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-foreground">What changes</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                <li>The project stops appearing in Telar and no new sessions can be started on it</li>
                <li>Its existing sessions keep their history but show no project until it is registered again</li>
                <li>
                  Registering the same folder again brings it back, with a new project id — anything stored against the old id
                  (its MCP servers, its data-science and LaTeX settings) is not carried over
                </li>
              </ul>
            </div>
            <p className="text-muted-foreground">
              A session with work in flight blocks this. Let it finish, or stop it, and try again — Telar will not end somebody&apos;s turn to
              remove a project.
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <XIcon />
              <AlertTitle>Couldn&apos;t remove</AlertTitle>
              <AlertDescription className="text-xs break-words">{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy || !project}>
              {busy && <Loader2Icon className="animate-spin" />}
              Remove from Telar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
