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
 * against. Then the honest screen is the register form, and it is the same
 * dialog the rail offers rather than a second one.
 *
 * AN UNREACHABLE ENGINE LANDS HERE TOO, and says so instead of redirecting into
 * a canvas that could only fail to load. Registering is still offered — the
 * daemon may well be back by the time the form is submitted, and the button
 * reports its own failure.
 */

import { useRouter } from "next/navigation";
import { FolderPlusIcon, PlugZapIcon } from "lucide-react";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";

export function FirstRun({ unreachable = false }: { unreachable?: boolean }) {
  const router = useRouter();
  const Icon = unreachable ? PlugZapIcon : FolderPlusIcon;
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <h1 className="font-heading text-lg font-semibold tracking-tight">
          {unreachable ? "The engine is not answering" : "Register a project"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {unreachable
            ? "Nothing is claiming turns, so this cockpit has no sessions to show. Start the local engine and reload."
            : "Point Telar at a checkout on this machine. Everything after that starts with a message."}
        </p>
        <div className="mt-5 flex justify-center">
          {/* `router.refresh()`, not a client-side list update: this page's job
              is to REDIRECT once a project exists, and that decision is made on
              the server. Re-running it is what carries you to the composer. */}
          <RegisterProjectDialog onRegistered={() => router.refresh()} />
        </div>
      </div>
    </div>
  );
}
