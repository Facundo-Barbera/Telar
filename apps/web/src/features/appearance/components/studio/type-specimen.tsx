"use client";

import { cn } from "@/ui/utils";

function Chip({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("mx-0.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 align-baseline text-[0.9em]", tone)}>
      <span aria-hidden>{mark}</span>
      <code className="bg-transparent p-0 text-[inherit]">{children}</code>
    </span>
  );
}

export function InterfaceSpecimen() {
  return (
    <p className="rounded-md border border-border px-3 py-2.5 text-sm leading-relaxed">
      Ask <Chip mark="✦" tone="border-primary/30 text-primary">Designer</Chip> to fix the flaky assertion in{" "}
      <Chip mark="TS" tone="border-border text-muted-foreground">studio-draft.test.ts</Chip> and match the header to{" "}
      <Chip mark="⚛" tone="border-info/30 text-info">panel.tsx</Chip> before you ship.
    </p>
  );
}

const DIFF: { sign: " " | "-" | "+"; n: number; text: string }[] = [
  { sign: " ", n: 1, text: "export function lookThemeId(look: Look) {" },
  { sign: "-", n: 2, text: "  return `look-${look.id}`; // 0O 1lI" },
  { sign: "+", n: 2, text: "  return `look-${look.id.trim()}`;" },
  { sign: " ", n: 3, text: "}" },
];

export function CodeSpecimen() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <code className="text-muted-foreground">lib/looks.ts</code>
        <span className="ml-auto font-mono text-2xs tabular-nums">
          <span className="text-destructive">−1</span> <span className="text-success">+1</span>
        </span>
      </div>
      <pre className="overflow-x-auto py-1.5 leading-relaxed">
        {DIFF.map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-3 px-3",
              line.sign === "-" && "bg-destructive/10",
              line.sign === "+" && "bg-success/10",
            )}
          >
            <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/50">{line.n}</span>
            <code className="whitespace-pre">{line.text}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}

export function TerminalSpecimen() {
  return (
    <pre className="overflow-x-auto rounded-md border border-border px-3 py-2.5 leading-relaxed">
      <code className="whitespace-pre">
        <span className="text-success">→</span> Local: <span className="text-info">http://127.0.0.1:3100/</span>
        {"\n\n"}
        <span className="text-success">✓ 1061 passed</span> <span className="text-warning">△ 6 warnings</span>{" "}
        <span className="text-destructive">✗ 0 failed</span>
        {"\n"}
        <span className="rounded bg-success/20 px-1 text-success">READY</span> watching — press <kbd className="text-[inherit]">q</kbd> to quit
      </code>
    </pre>
  );
}
