"use client";

import { useState } from "react";
import { normaliseColourText } from "../../colour-field";
import { Input } from "@/ui/input";
import { cn } from "@/ui/utils";

export function HexField({
  value,
  label,
  className,
  live = false,
  onCommit,
}: {
  value: string;
  label: string;
  className?: string;
  live?: boolean;
  onCommit: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const hex = normaliseColourText(text);
    if (hex) onCommit(hex);
    else setText(value);
  };
  return (
    <Input
      value={editing ? text : value}
      aria-label={`${label} hex value`}
      spellCheck={false}
      className={cn("h-6 w-[4.75rem] shrink-0 px-1.5 font-mono text-3xs tabular-nums", className)}
      onFocus={() => {
        setEditing(true);
        setText(value);
      }}
      onChange={(event) => {
        setText(event.target.value);
        if (!live) return;
        const hex = normaliseColourText(event.target.value);
        if (hex) onCommit(hex);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          setEditing(false);
          setText(value);
        }
      }}
    />
  );
}
