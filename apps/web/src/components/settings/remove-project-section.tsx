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
 * IT LIVES UNDER "Project", beside the name, checkout and id it is about, as
 * the LAST group on that page, under a plain "Danger" label. Still no red zone:
 * the panel, the border and the colour would promise more drama than a
 * reversible registry write deserves. What the label buys is structure — a
 * destructive action is never adjacent to an ordinary one — and the actual
 * safety is the row's copy naming what survives, which is cheaper and more
 * reliable than any amount of red.
 *
 * THE ENGINE OWNS THE REFUSAL. A project with a session mid-turn answers 409
 * and this shows the sentence it sent; the surface never decides for itself
 * that removing is safe, and never stops somebody's work to make it so.
 *
 * WHICH MAC IT ACTS ON is not this component's business and never was: the
 * module-level `createEngineApi()` every screen here uses resolves the host
 * from the pathname AT CALL TIME (lib/hosts/client.ts), so a remote Mac's
 * screens under `/hosts/:id/…` already send to that Mac's proxy. An earlier
 * draft took an injected client to "make hosts work", which was a seam nobody
 * passed and a claim the default fetcher had already made true.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, XIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { announceProjectsChanged } from "@/lib/projects";
import { createRequestGate } from "@/lib/request-gate";
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

/** One client for this cockpit, like every other section in this directory.
 *  Host-aware by construction — see the note above. */
const api = createEngineApi();

export function RemoveProjectSection({
  project,
  onChange,
}: {
  project?: Project;
  /** Hand the changed record back so the page re-renders as removed/restored
   *  without a round trip. */
  onChange: (project: Project) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * WHICH REQUEST IS ALLOWED TO FINISH — see lib/request-gate.ts. Two things
   * can make an answer stale: another submission, or the SUBJECT CHANGING
   * under a component that never unmounted. The parent keys this section by
   * project id so the common case is a remount, but a key is a convention and
   * this is a correctness guard, so the gate is retargeted below as well.
   */
  // `useState` with a lazy initialiser rather than a ref: one gate per mounted
  // pane, created once, and readable during render without tripping the
  // refs-during-render rule.
  const [gate] = useState(createRequestGate);
  /** Still on screen? A response that lands after this page has been replaced
   *  must not set state or steer the router. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const identity = project?.id ?? "";
  useEffect(() => {
    // The project this pane is about changed while it stayed mounted. Whatever
    // is in flight was about the old one: disown it at once — that is a plain
    // call, and the part that matters for correctness — then put the dialog
    // back to a state that belongs to the new subject rather than leaving a
    // spinner or the previous project's error sitting over it. The visual
    // reset is deferred a tick because setting state in an effect BODY is the
    // cascade the lint rule forbids, the same shape as `useProjects`.
    gate.retarget(identity);
    const task = window.setTimeout(() => {
      setBusy(false);
      setOpen(false);
      setError(null);
    }, 0);
    return () => window.clearTimeout(task);
  }, [gate, identity]);

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
    // The in-flight guard is the gate's, not the `busy` state's: two clicks in
    // one frame both see the same stale `busy`.
    const token = gate.begin(target);
    if (token === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const answer = action === "remove" ? await api.unregisterProject(target) : await api.restoreProject(target);
      if (!gate.settle(token) || !live.current) return;
      onChange(answer.project);
      announceProjectsChanged();
      setBusy(false);
      setOpen(false);
      // Leaving is only right for a removal this screen is still about. The
      // two guards above are what stop a late answer from navigating a page
      // the person has since moved to.
      if (action === "remove") router.push("/");
    } catch (cause) {
      if (!gate.settle(token) || !live.current) return;
      setError(cause instanceof EngineApiError ? cause.message : `Could not ${action} this project.`);
      setBusy(false);
    }
  };

  if (removed) {
    return (
      <SettingsGroup title="Removed from Telar" description="Put away — nothing on disk was touched.">
        <Row
          label="Restore this project"
          // The caption above already says nothing on disk was touched; what
          // this row adds is that the RECORD survived too — same id, same
          // settings, same sessions.
          hint="Same id, same settings, same sessions. Registering the folder again does this too."
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
    // "DANGER" IS THE LABEL, AND THE LABEL IS THE WHOLE DEVICE — no red panel,
    // no scary border. The separation is structural: a plain group at the floor
    // of the page, so a destructive action is never adjacent to an ordinary one
    // and never dressed up as more than it is. The safety comes from the row's
    // own copy, below, which is a cheaper and more reliable guard than colour.
    <SettingsGroup title="Danger">
      <Row
        label="Remove project from Telar"
        // WHAT IT DOES NOT DESTROY, in the row. Removal stops Telar offering the
        // project; it is a registry write and nothing else, and saying so here is
        // what lets somebody press the button without opening the dialog to find
        // out whether their repository survives.
        hint="No new sessions can start on it. Files on disk are not touched, and you can put it back."
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
