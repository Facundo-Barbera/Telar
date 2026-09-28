"use client";

import { useRouter } from "next/navigation";
import { FolderGit2Icon } from "lucide-react";
import { GREETING } from "../greetings";
import { projectSettingsHref } from "@/features/projects";
import { useHostProjects } from "@/features/hosts";
import { LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { canvasHref } from "@/features/sessions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

export function FreshGreeting({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const router = useRouter();
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
            <span className="min-w-0 truncate">{name}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-64">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => {
                  if (project.id !== projectId) router.push(canvasHref(project.id, hostId));
                }}
              >
                <FolderGit2Icon />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            {hostId === LOCAL_HOST_ID && projects.length > 0 && <DropdownMenuSeparator />}
            {hostId === LOCAL_HOST_ID && (
              <DropdownMenuItem onClick={() => router.push(projectSettingsHref(projectId))}>
                Project settings…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="-ml-1.5">{GREETING.after}</span>
      </h1>
    </div>
  );
}
