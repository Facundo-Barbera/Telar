"use client";

/**
 * REMOVE A PROJECT FROM TELAR, and put it back.
 *
 * THE COPY IS SHORT BECAUSE THE BEHAVIOUR IS SIMPLE. Removal is reversible and
 * touches nothing on disk, so the dialog says that in two sentences rather
 * than enumerating a repository's contents at somebody. An earlier draft
 * listed everything that survives; that list existed to reassure against a
 * risk the design no longer takes.
 *
 * IT LIVES UNDER "Project", beside the name, checkout and id it is about,
 * rather than in a red "danger zone" — there is one such action, and a zone
 * built for it would promise more drama than a reversible registry write
 * deserves.
 *
 * THE ENGINE OWNS THE REFUSAL. A project with a session mid-turn answers 409
 * and this shows the sentence it sent; the surface never decides for itself
 * that removing is safe, and never stops somebody's work to make it so.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, XIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { announceProjectsChanged } from "@/lib/projects";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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

/** One client for this cockpit, like every other section in this directory. */
const localApi = createEngineApi();

export function RemoveProjectSection({
  project,
  onChange,
  api = localApi,
}: {
  project?: Project;
  /** Hand the changed record back so the page re-renders as removed/restored
   *  without a round trip. */
  onChange: (project: Project) => void;
  /**
   * The cockpit this project belongs to. Injected rather than constructed here
   * so a page scoped to another Mac's engine removes THAT engine's project —
   * and so a request cannot be answered by a different host than the one it
   * was sent to.
   */
  api?: ReturnType<typeof createEngineApi>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * WHICH REQUEST IS ALLOWED TO FINISH. Every submission takes a ticket; a
   * response whose ticket is no longer the current one is dropped on the
   * floor. Without it, a click on a project, a navigation, and a click on
   * another project can interleave so that the first response lands on the
   * second project's screen — announcing a change to a registry that did not
   * make it, and redirecting a page the person is now reading.
   */
  const ticket = useRef(0);
  /** Still on screen? A response that lands after this page has been replaced
   *  must not set state or steer the router. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const removed = project?.removedAt !== undefined;

  const handleOpenChange = (next: boolean) => {
    // A REQUEST IN FLIGHT PINS THE DIALOG OPEN. Closing it used to clear
    // `busy`, which re-enabled the button under a request that had not
    // answered — one more click, two removals, and a stale response deciding
    // what the screen says.
    if (!next && busy) return;
    setOpen(next);
    if (!next) setError(null);
  };

  const run = async (action: "remove" | "restore") => {
    if (!project) return;
    const target = project.id;
    const mine = (ticket.current += 1);
    setBusy(true);
    setError(null);
    try {
      const answer = action === "remove" ? await api.unregisterProject(target) : await api.restoreProject(target);
      if (ticket.current !== mine || !live.current) return;
      onChange(answer.project);
      announceProjectsChanged();
      setBusy(false);
      setOpen(false);
      // Leaving is only right for a removal made from this screen. The two
      // guards above are what stop a late answer from navigating a page the
      // person has since moved to.
      if (action === "remove") router.push("/");
    } catch (cause) {
      if (ticket.current !== mine || !live.current) return;
      setError(cause instanceof EngineApiError ? cause.message : `Could not ${action} this project.`);
      setBusy(false);
    }
  };

  if (removed) {
    return (
      <SettingsGroup title="Removed from Telar" description="This project is put away. Its sessions and their history are still here to read.">
        <Row
          label="Restore this project"
          hint="Brings it back with the same id, settings and sessions. Registering its folder again does the same thing."
          control={
            <div className="flex items-center gap-2">
              <Badge variant="outline">Removed</Badge>
              <Button size="sm" disabled={busy} onClick={() => void run("restore")}>
                {busy && <Loader2Icon className="animate-spin" />}
                Restore
              </Button>
            </div>
          }
        />
        {error && (
          <Alert variant="destructive">
            <XIcon />
            <AlertTitle>Couldn&apos;t restore</AlertTitle>
            <AlertDescription className="text-xs break-words">{error}</AlertDescription>
          </Alert>
        )}
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title="Remove from Telar" description="Stop offering this project, without deleting anything.">
      <Row
        label="Remove project from Telar"
        hint="Nothing in the repository is touched, and you can put it back."
        control={
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={!project} onClick={() => handleOpenChange(true)}>
            Remove…
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {project?.name ?? "this project"} from Telar?</DialogTitle>
            <DialogDescription>
              Telar stops offering it and no new sessions can start on it. Nothing on disk is deleted, and its sessions stay here to read.
            </DialogDescription>
          </DialogHeader>

          <p className="text-xs text-muted-foreground">
            You can put it back from this page, or by registering{" "}
            <span className="font-mono break-all">{project?.root ?? "the same folder"}</span> again — it returns with the same settings and
            sessions.
          </p>

          {error && (
            <Alert variant="destructive">
              <XIcon />
              <AlertTitle>Couldn&apos;t remove</AlertTitle>
              <AlertDescription className="text-xs break-words">{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button type="button" variant="destructive" onClick={() => void run("remove")} disabled={busy || !project}>
              {busy && <Loader2Icon className="animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
