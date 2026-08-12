"use client";

/**
 * The sentence over an empty composer, and the project picker inside it.
 *
 * TWO CONTROLS IN ONE LINE, and they are different gestures on purpose:
 *   - THE PROJECT is a dropdown. It is the one decision a new conversation has
 *     to make and could not previously be changed without going back to a
 *     different screen — you picked a project, then discovered you were on the
 *     wrong one, and the only way out was the browser's back button.
 *   - THE PHRASE rerolls. Costs nothing, changes nothing, and is the reason
 *     anybody notices the line is alive.
 *
 * THE ROTATION IS PER VISIT, NOT PER SECOND. A line that rewrites itself on a
 * timer, directly above the box you are typing into, is a distraction with no
 * upside. Each new conversation gets the next phrase; pressing it steps on.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import { GREETINGS, greetingForVisit, nextGreeting } from "@/lib/greetings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const api = createVNextApi();

/** Where the rotation counter lives. Versioned like every other key this app
 *  writes, so a shape change cannot poison an old one. */
const ROTATION_KEY = "telar:greeting:v1";

export function FreshGreeting({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    /**
     * DEFERRED TO A TASK, which is this app's established shape for "read
     * something the server could not have known". The server rendered phrase 0
     * because it has no localStorage and no random it can agree with the client
     * about; picking here and swapping is the only hydration-safe way to
     * rotate, and it is why phrase 0 is the plainest one.
     */
    const task = window.setTimeout(() => {
      try {
        const seen = Number(window.localStorage.getItem(ROTATION_KEY) ?? "0");
        setIndex(greetingForVisit(seen));
        window.localStorage.setItem(ROTATION_KEY, String(nextGreeting(seen)));
      } catch {
        // Private browsing, or storage disabled. The canonical phrase is a
        // perfectly good answer and nothing else here depends on it.
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await api.projects()).projects);
    } catch {
      // The picker simply does not open. The sentence still reads.
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(task);
  }, [loadProjects]);

  const greeting = GREETINGS[index] ?? GREETINGS[0]!;
  const name = projectName ?? projectId;

  return (
    <div className="mb-6 px-4 text-center">
      <h1 className="text-pretty text-2xl font-semibold tracking-tight sm:text-3xl">
        {/* The phrase, and pressing it steps to the next one. A `<button>`
            rather than a click handler on the text so it is reachable from the
            keyboard like everything else in this app. */}
        <button
          type="button"
          onClick={() => setIndex((current) => nextGreeting(current))}
          title="Another one"
          className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {greeting.before}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Project: ${name}. Change it.`}
                title="Work on a different project"
                className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-lg px-1.5 text-primary underline decoration-primary/30 decoration-2 underline-offset-4 outline-none transition-colors hover:bg-primary/10 hover:decoration-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <span className="min-w-0 truncate">{name}</span>
            <ChevronDownIcon className="size-4 shrink-0 self-center opacity-50" />
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
                  // in.
                  if (project.id !== projectId) router.push(`/projects/${encodeURIComponent(project.id)}/sessions/new`);
                }}
              >
                <FolderGit2Icon />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            {projects.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => router.push("/projects")}>Manage projects…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => setIndex((current) => nextGreeting(current))}
          title="Another one"
          className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {greeting.after}
        </button>
      </h1>
    </div>
  );
}
