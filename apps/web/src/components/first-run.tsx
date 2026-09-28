"use client";

/**
 * The only screen `/` can show that is not a composer.
 *
 * IT REPLACED A 264-LINE PROJECTS TABLE, and the difference is what the screen
 * is FOR. The table listed registered roots, engine health and every session by
 * raw id — a management view for a surface nobody was managing, reachable by
 * accident (a delete, a breadcrumb, a stray menu item) and sticky across
 * reloads, so the app kept coming back to a page that was never the destination.
 * The project view will exist again when there is something for it to do.
 *
 * WHAT IS LEFT IS THE ONE CASE THE REDIRECT CANNOT SERVE: a new-session canvas
 * has to name a project, so with none registered there is nothing to open one
 * against. Then the honest screen is the way in to a project, and it is the same
 * palette the rail offers rather than a second one.
 *
 * AN UNREACHABLE ENGINE LANDS HERE TOO, and says so instead of redirecting into
 * a canvas that could only fail to load. Adding is still offered — the daemon may
 * well be back by the time a folder is chosen, and the palette reports its own
 * failure.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlusIcon, PlugZapIcon } from "lucide-react";
import { ProjectPalette } from "@/components/project-palette";
import { Button } from "@/components/ui/button";

export function FirstRun({ unreachable = false }: { unreachable?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const Icon = unreachable ? PlugZapIcon : FolderPlusIcon;
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <h1 className="font-heading text-lg font-semibold tracking-tight">
          {unreachable ? "The engine is not answering" : "Add a project"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {unreachable
            ? "Nothing is claiming turns, so this cockpit has no sessions to show. Start the local engine and reload."
            : "Point Telar at a checkout on this machine, or clone one. Everything after that starts with a message."}
        </p>
        <div className="mt-5 flex justify-center">
          <Button size="sm" onClick={() => setOpen(true)}>
            <FolderPlusIcon />
            Add project
          </Button>
        </div>
      </div>
      {/* `router.refresh()`, not a client-side list update: this page's job is to
          REDIRECT once a project exists, and that decision is made on the server.
          Re-running it is what carries you to the composer.

          NO TARGETS, so the Projects page is empty and its one row is the way
          into Sources — which is where this screen sends people anyway. */}
      <ProjectPalette
        open={open}
        page="sources"
        onOpenChange={setOpen}
        targets={[]}
        onChoose={() => {}}
        onRegistered={() => router.refresh()}
      />
    </div>
  );
}
