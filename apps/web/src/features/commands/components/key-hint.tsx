"use client";

import type { ReactNode } from "react";
import type { CommandId } from "../commands";
import { keyCaps, useKeyCapPlatform } from "../key-caps";
import { useModifierHeld } from "../modifier-held";
import { useKeymap } from "../use-command-keys";
import { cn } from "@/ui/utils";

const APPEAR = "animate-in fade-in-0 duration-[80ms] motion-reduce:animate-none";

export function KeyHint({
  command,
  always = false,
  className,
}: {
  command: CommandId;
  always?: boolean;
  className?: string;
}) {
  const keymap = useKeymap();
  const platform = useKeyCapPlatform();
  const held = useModifierHeld();
  const caps = keyCaps(keymap[command] ?? "", platform);
  if (caps.length === 0) return null;
  if (!always && !held) return null;
  return (
    <span
      aria-hidden
      data-slot="key-hint"
      className={cn("pointer-events-none inline-flex shrink-0 items-center gap-0.5", !always && APPEAR, className)}
    >
      {caps.map((cap, index) => (
        <kbd
          key={`${cap}-${index}`}
          className="rounded-[3px] bg-foreground/8 px-1 font-mono text-3xs leading-4 text-muted-foreground"
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}

export function KeyHintOverlay({
  command,
  children,
  className,
}: {
  command: CommandId;
  children: ReactNode;
  className?: string;
}) {
  const keymap = useKeymap();
  const held = useModifierHeld();
  const showing = held && Boolean(keymap[command]);
  return (
    <span className={cn("relative inline-flex shrink-0 items-center", className)}>
      <span className={cn("transition-opacity duration-[80ms] motion-reduce:transition-none", showing && "opacity-20")}>{children}</span>
      {showing && (
        <span aria-hidden className="absolute inset-y-0 right-0 flex items-center">
          <KeyHint command={command} />
        </span>
      )}
    </span>
  );
}
