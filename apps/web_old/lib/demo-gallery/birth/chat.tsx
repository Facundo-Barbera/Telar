"use client";
// LANE: birth (UX brainstorm 2026-07-23) — chat primitives for the birth of
// a loom, built ON the production session UI (session verdict: use the real
// sessions surface, stripped of the sidebar and app chrome). User turns are
// the real right-aligned bg-secondary bubble; assistant turns are bare text
// (ai-elements/message idiom); working states are the REAL WorkingIndicator
// with a live clock; the composer is the real InputGroup frame.
import { useEffect, useState } from "react";
import { CircleCheckIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  WorkingIndicator,
  type WorkState,
} from "@/components/session/working-indicator";
import { cn } from "@/lib/utils";

// Staged reveal: the conversation PLAYS when a weight opens instead of
// arriving pre-rendered. Pass a module-level const so the effect runs once.
export function useReveal(delays: readonly number[]) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    let acc = 0;
    const timers = delays.map((d, i) => {
      acc += d;
      return setTimeout(() => setStep(i + 1), acc);
    });
    return () => timers.forEach(clearTimeout);
  }, [delays]);
  return step;
}

export function TurnYou({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full">
      <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-4 py-3 text-sm text-foreground">
        {children}
      </div>
    </div>
  );
}

export function TurnAgent({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-foreground">{children}</div>
  );
}

// Dashed system marker inside the conversation — state, never prose.
export function Marker({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2">
      <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export function MonoLine({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[10px] text-muted-foreground/60">{children}</p>;
}

// The production WorkingIndicator with its clock actually ticking.
export function LiveIndicator({
  kind,
  tool,
  target,
}: {
  kind: "thinking" | "working" | "tool";
  tool?: string;
  target?: string;
}) {
  const [startedAt] = useState(Date.now);
  const state: WorkState =
    kind === "tool"
      ? {
          kind,
          tool: tool ?? "Bash",
          target: target ?? "",
          startedAt,
          lastActivityAt: startedAt,
        }
      : { kind, startedAt };
  return <WorkingIndicator state={state} className="w-fit max-w-full" />;
}

// The gate at chat scale — real Buttons, primary/outline exactly like the
// session's own affordances.
export function ChoiceRow({
  choices,
  onPick,
}: {
  choices: { label: string; kind?: "primary" }[];
  onPick: (label: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {choices.map((c) => (
        <Button
          key={c.label}
          type="button"
          size="sm"
          variant={c.kind === "primary" ? "default" : "outline"}
          onClick={() => onPick(c.label)}
        >
          {c.label}
        </Button>
      ))}
    </div>
  );
}

export function DoneLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

// Wireframe screenshot placeholder, chat-sized.
export function Thumb({ label }: { label: string }) {
  return (
    <figure className="w-36 shrink-0">
      <div className="flex aspect-video flex-col gap-1 rounded-md border border-border bg-muted/30 p-1.5">
        <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        <div className="h-1.5 w-1/2 rounded-sm bg-muted-foreground/15" />
        <div className="mt-auto flex gap-1">
          <div className="h-3 flex-1 rounded-sm bg-muted-foreground/10" />
          <div className="h-3 w-1/3 rounded-sm bg-muted-foreground/20" />
        </div>
      </div>
      <figcaption className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">
        {label}
      </figcaption>
    </figure>
  );
}

// The real composer frame (InputGroup — same skeleton PromptInput wraps),
// present at every weight: control lives in the chat.
export function Composer({ hint, note }: { hint: string; note: string }) {
  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className={cn("mx-auto w-full max-w-2xl")}>
        <InputGroup>
          <InputGroupTextarea
            placeholder={hint}
            className="field-sizing-content max-h-48 min-h-10"
          />
          <InputGroupAddon align="block-end" className="justify-between gap-1">
            <span className="font-mono text-[10px] text-muted-foreground/50">{note}</span>
            <InputGroupButton
              size="icon-sm"
              variant="default"
              aria-label="Send"
            >
              <SendIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}
