"use client";

/**
 * THE SPECIMENS — what the setting does, shown rather than described.
 *
 * A font picker that offers only a family name and a number asks the reader to
 * imagine the result and then go hunting through the app to check. These two
 * blocks are the check, in place: a sentence of real interface text with the
 * chips and emphasis it actually carries, and a code block plus a run of
 * terminal output in the mono face at the mono size.
 *
 * THEY ARE NOT MOCK-UPS. Nothing here sets a font: the studio paints the draft
 * on the document (lib/studio-preview.ts), so these inherit exactly what every
 * other surface is wearing. That is the whole reason they can be trusted — a
 * specimen that styled itself would be a second opinion about the setting, and
 * the pane has spent this rebuild deleting second opinions.
 *
 * The mono blocks use `pre`/`code` deliberately: those are the elements
 * `--app-font-mono-size` lands on in globals.css, so the specimen resizes for
 * exactly the reason the reader's code will.
 *
 * AND THEY LIVE IN THE 42REM READING COLUMN (#435), like every other settings
 * pane. That is a budget, not a suggestion: the card leaves about 600px, and
 * the mono size is a setting that goes up to 18px — so a sample line much past
 * forty characters cannot be shown WHOLE at the biggest face somebody can
 * choose. Past that the block scrolls, and a specimen you have to scroll to
 * read has stopped answering the question it was put here to answer.
 * `type-specimen.test.tsx` does the arithmetic from the real constants; keep
 * new sample lines under the limit it computes rather than widening the pane.
 */

import { cn } from "@/lib/utils";

function Chip({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("mx-0.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 align-baseline text-[0.9em]", tone)}>
      <span aria-hidden>{mark}</span>
      <code className="bg-transparent p-0 text-[inherit]">{children}</code>
    </span>
  );
}

/** Interface text as it really appears: prose carrying inline marks, which is
 *  where a typeface's fit is actually decided. */
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

/** A diff, because code is read at its worst in one: digits beside letters,
 *  and the 0/O 1/l/I confusions a mono face exists to settle. */
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

/** Terminal output — the other place mono earns its keep, and the one where
 *  colour and alignment matter as much as the letterforms. */
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
