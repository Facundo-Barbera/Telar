"use client";

// A command the user runs THEMSELVES, with a copy button. Never a button that
// runs it for them. Ported verbatim from the frozen app's
// components/settings/copy-command.tsx, with two changes:
//
//   · The copied tick moved off a raw Tailwind emerald ramp and onto
//     `text-success`. This app holds every state colour on the five-token
//     vocabulary (app/globals.css) so a tick here and a status dot elsewhere
//     cannot disagree about what green means — and app/globals.test.ts scans
//     for the raw ramps, comments included, which is why this sentence does not
//     spell the old class name.
//   · CLIPBOARD ACCESS IS NOT GUARANTEED HERE. `navigator.clipboard` exists
//     only in a secure context, and this cockpit is served over plain HTTP the
//     moment it is bound to anything other than localhost — the same trap that
//     took out `crypto.randomUUID` (see lib/engine/client.ts). So the absence is
//     handled rather than caught: the command stays on screen and selectable,
//     which is the fallback that always works.

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
      <code className="min-w-0 flex-1 truncate font-mono text-2xs">{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy command"
        onClick={() => {
          navigator.clipboard
            ?.writeText(command)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              // Denied, or no clipboard at all on an insecure origin. The
              // command is on screen and selectable either way.
            });
        }}
      >
        {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </Button>
    </div>
  );
}
