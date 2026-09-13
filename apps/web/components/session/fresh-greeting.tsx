"use client";

/**
 * The sentence over an empty composer, and the project picker inside it.
 *
 * ONE CONTROL IN THE LINE, and it is the project: a dropdown, because that is
 * the one decision a new conversation has to make and could not previously be
 * changed without going back to a different screen — you picked a project, then
 * discovered you were on the wrong one, and the only way out was the browser's
 * back button.
 *
 * THE PHRASE NO LONGER REROLLS, BECAUSE THERE IS ONLY ONE. It used to be a
 * rotation of fourteen quips with a press-to-reroll button on each half — see
 * `lib/greetings.ts` for why a joke over the box you came here to type into
 * stops being funny on the second reading.
 *
 * THE PUNCTUATION HUGS THE NAME. The trigger is a padded, marginned control, so
 * the half-sentence after it began a full 8px away from the last letter and read
 * as "exoplanets ?" (#355). The trailing text pulls itself back across that
 * padding; the leading half needs no such thing, because it ends in a real
 * space.
 *
 * THE PICKER IS ABOUT ONE MAC. A canvas can be a remote Mac's
 * (`/hosts/:id/projects/:id/sessions/new`), and project ids are minted per
 * engine — two Macs can hand out the same one. So the list comes from
 * `useHostProjects`, which keeps each answer with the host it describes, and
 * every destination is built with that host in it. Listing a remote Mac's
 * projects behind a local link is the #204 defect in miniature
 * (docs/investigations/204-host-identity.md).
 */

import { useRouter } from "next/navigation";
import { FolderGit2Icon } from "lucide-react";
import { GREETING } from "@/lib/greetings";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { useHostProjects } from "@/lib/hosts/host-projects";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";
import { canvasHref } from "@/lib/session-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function FreshGreeting({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const router = useRouter();
  /**
   * THE SHARED REGISTRY, NOT A ONE-SHOT FETCH, AND ONE MAC'S. This component
   * lives for the whole composer (switching projects is a router.push that
   * reuses it), so a list loaded once on mount was frozen: a project registered
   * after the composer opened stayed invisible until a hard reload. The hook
   * re-reads on the registry's own change event — and answers only for the host
   * this canvas is on, so a list from a Mac we have left is dropped rather than
   * shown under this one's name.
   */
  const { hostId, projects } = useHostProjects();

  const name = projectName ?? projectId;

  return (
    <div className="mb-6 px-4 text-center">
      <h1 className="text-pretty text-2xl font-semibold tracking-tight sm:text-3xl">
        {GREETING.before}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Project: ${name}. Change it.`}
                title="Change project"
                className="inline-flex max-w-full items-baseline gap-1 rounded-lg px-1.5 text-primary underline decoration-primary/30 decoration-2 underline-offset-4 outline-none transition-colors hover:bg-primary/10 hover:decoration-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            {/* No chevron: the underline already reads as "press me", and the
                arrow crowded the sentence it lives inside. */}
            <span className="min-w-0 truncate">{name}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-64">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => {
                  // A NAVIGATION, not a state change: the canvas is addressed by
                  // project, so switching projects means going to the other
                  // project's canvas. Anything else would leave the URL lying
                  // about which project the first message will create a session
                  // in — and the HOST is part of that address, because the id
                  // came from that Mac's registry and means nothing on another.
                  if (project.id !== projectId) router.push(canvasHref(project.id, hostId));
                }}
              >
                <FolderGit2Icon />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            {/*
              THIS PROJECT'S settings, not a list of every project. It said
              "Manage projects…" and went to a table that has been retired — and
              the thing a person wants from a menu that already names the project
              they are in is that project's own screen.

              LOCAL ONLY, because there is no such screen for another Mac's
              project: the settings route exists at
              `/projects/:id/settings` and has no `/hosts/:id/…` counterpart.
              Offering it on a remote canvas would push a local URL carrying a
              remote project id — the exact confusion this component was just
              fixed for. Absent rather than disabled: a menu item that cannot go
              anywhere is noise.
            */}
            {hostId === LOCAL_HOST_ID && projects.length > 0 && <DropdownMenuSeparator />}
            {hostId === LOCAL_HOST_ID && (
              <DropdownMenuItem onClick={() => router.push(projectSettingsHref(projectId))}>
                Project settings…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* PULLED BACK ACROSS THE TRIGGER'S PADDING (#355). The control above
            carries `px-1.5` so its hover plate has room around the name, which
            also put 6px between the last letter and the question mark — enough
            to read as a typo rather than as a sentence. */}
        <span className="-ml-1.5">{GREETING.after}</span>
      </h1>
    </div>
  );
}
