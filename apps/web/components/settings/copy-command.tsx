"use client";

// A command the user runs THEMSELVES, with a copy button. Never a button that
// runs it for them.
//
// Shared by both settings surfaces because both hand over commands Telar
// deliberately does not execute: the sign-in line for an account whose login
// lives in the user's terminal, and the restart that clears the gateway's
// management lockout — a lockout that any automatic retry would extend rather
// than recover from.

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy command"
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              // Clipboard denied — the command is on screen and selectable.
            });
        }}
      >
        {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
      </Button>
    </div>
  );
}
