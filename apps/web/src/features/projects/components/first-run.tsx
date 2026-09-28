"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlusIcon, PlugZapIcon } from "lucide-react";
import { ProjectPalette } from "./project-palette";
import { Button } from "@/ui/button";

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
