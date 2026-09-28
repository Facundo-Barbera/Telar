"use client";

import { XIcon } from "lucide-react";
import type { ProviderInstance } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { DRIVER_LABEL } from "../provider-instances";

export type InheritanceNotice = {
  names: readonly string[];
  onCarryOver: () => void;
  onDismiss: () => void;
};

export function InheritanceNotice({ driver, names, onCarryOver, onDismiss }: InheritanceNotice & { driver: ProviderInstance["driver"] }) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3" role="status">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          This login has stopped inheriting {names.length === 1 ? "a variable" : `${names.length} variables`} from Telar
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon className="size-3" />
        </Button>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">
        Configuring a login stops it picking up {DRIVER_LABEL[driver]}&rsquo;s own variables from the environment Telar was
        launched with — otherwise an ambient key or proxy would silently replace this login&rsquo;s identity. Telar was passing
        {names.length === 1 ? " this one" : " these"} down, and no longer will:
      </p>
      <ul className="flex flex-wrap gap-1">
        {names.map((name) => (
          <li key={name}>
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-3xs text-foreground">{name}</code>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pt-0.5">
        <Button size="sm" className="h-7 px-2 text-xs" onClick={onCarryOver}>
          Keep {names.length === 1 ? "it" : "them"} for this login
        </Button>
      </div>
      <p className="text-2xs leading-snug text-muted-foreground/70">
        Keeping {names.length === 1 ? "it" : "them"} copies the current value into this login&rsquo;s own environment below, where
        it survives. The value is read by the engine and never shown here; a credential is stored as a secret. If this login is
        meant to have its own identity, dismiss this instead.
      </p>
    </div>
  );
}
