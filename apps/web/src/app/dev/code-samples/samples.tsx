"use client";

import { useState } from "react";
import { MessageResponse } from "@/components/ui/message";
import { CodeSurface } from "@/components/ui/code-surface";
import { OverlayEditor } from "@/components/session/overlay-editor";

const SHORT_TS = "```ts\nconst a = 1;\nexport default a;\n```";
const SHORT_PLAIN = "```\ncheckpoint-before-provider-failure\ncheckpoint-after-continuation\n```";
const LONG_TS = "```tsx\n" + Array.from({ length: 40 }, (_, i) => `export function line${i}(value: number): number {\n  return value * ${i}; // a comment that is long enough to force a horizontal scroll at a narrow measure, never a wrap\n}`).join("\n") + "\n```";
const STREAMING = "Here is the start of an answer with a fence that has not closed yet:\n\n```py\ndef partial(x):\n    return x +";
const OUTPUT_SHORT = "$ bun test\n 30 pass\n 0 fail";
const OUTPUT_LONG = Array.from({ length: 60 }, (_, i) => `[${String(i).padStart(3, "0")}] a line of tool output that is long enough to wrap when the measure is narrow because output is skimmed, not read as source`).join("\n");
const DIFF = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n export default a;";

/**
 * THE EDITOR'S OWN FIXTURE: Python with the shapes that broke it.
 *
 * TWO CONSECUTIVE BLANK LINES, a blank line inside an indented block, a tab
 * indent and a trailing newline. Shiki returns an EMPTY token array for each
 * blank line, and rendering that as an empty element gives it no line box at
 * all — the lines vanished, the code slid up under the gutter, and the height
 * they were owed piled up at the end of the file. It is only visible ONCE THE
 * COLOURS LAND (the plain first paint was always correct), which is exactly why
 * it needs a place to be looked at: type in the box below, watch the highlight
 * arrive 120ms later, and the lines must not move.
 */
const PYTHON_BLANKS = `import os


def main():
    total = 0

    for index in range(3):
        total += index

\treturn total


if __name__ == "__main__":
    print(main())
`;

/** The two stacked layers, editable, exactly as a notebook cell and the file
 *  view both draw them. Local state so the caret can be tested by typing. */
function EditorSample() {
  const [value, setValue] = useState(PYTHON_BLANKS);
  return (
    <div className="rounded-md border border-border">
      <OverlayEditor value={value} onChange={setValue} language="python" ariaLabel="Blank-line fixture" minRows={4} />
    </div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Samples() {
  return (
    <>
      <h3 className="text-xs text-muted-foreground">Fenced · short · ts</h3>
      <MessageResponse>{SHORT_TS}</MessageResponse>
      <h3 className="text-xs text-muted-foreground">Fenced · short · no language</h3>
      <MessageResponse>{SHORT_PLAIN}</MessageResponse>
      <h3 className="text-xs text-muted-foreground">Fenced · streaming (unclosed)</h3>
      <MessageResponse streaming>{STREAMING}</MessageResponse>
      <h3 className="text-xs text-muted-foreground">Tool output · under the fold</h3>
      <CodeSurface text={OUTPUT_SHORT} wrap />
      <h3 className="text-xs text-muted-foreground">Tool output · 60 lines</h3>
      <CodeSurface text={OUTPUT_LONG} wrap />
      <h3 className="text-xs text-muted-foreground">Approval argument</h3>
      <CodeSurface text="rm -rf ./dist && bun run build" wrap tone="foreground" />
      <h3 className="text-xs text-muted-foreground">Diff-like source (no wrap)</h3>
      <CodeSurface text={DIFF} />
      <h3 className="text-xs text-muted-foreground">Fenced · 120 lines · tsx</h3>
      <MessageResponse>{LONG_TS}</MessageResponse>
      <h3 className="text-xs text-muted-foreground">Editor · blank lines, tab indent, trailing newline</h3>
      <EditorSample />
    </>
  );
}

export function CodeSamples() {
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 overflow-auto p-6 text-sm">
      <div className="min-w-0 flex-1">
        <Column title="Full measure (50rem lane)">
          <Samples />
        </Column>
      </div>
      <div className="w-72 shrink-0">
        <Column title="Narrow (18rem)">
          <Samples />
        </Column>
      </div>
    </div>
  );
}
