/**
 * A LABEL WITHOUT A GROUP TAKES THE PAGE DOWN.
 *
 * `DropdownMenuLabel` renders Base UI's `Menu.GroupLabel`, which reads
 * `MenuGroupContext` and THROWS when there is no `Menu.Group` above it:
 *
 *     Base UI: MenuGroupContext is missing. Menu group parts must be used
 *     within <Menu.Group> or <Menu.RadioGroup>.
 *
 * It does not degrade to an unstyled label or a missing one. It is a runtime
 * error, and it fires when the menu OPENS rather than when the page renders —
 * which is why it shipped: the composer's overflow menu only exists below
 * `@2xl/composer`, so every check that ran at full width saw a healthy trigger
 * and never opened the thing behind it.
 *
 * This is a source scan, in the same spirit as the palette scan in
 * app/globals.test.ts: a cheap structural check for a mistake that is invisible
 * until somebody clicks. It is deliberately a HEURISTIC — it does not parse JSX
 * — and it is written to fail loudly rather than to be clever, because the
 * alternative is finding out from a user.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const componentsRoot = path.join(here, "..");

function tsxFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(file));
    else if (file.endsWith(".tsx") && !file.includes(".test.")) out.push(file);
  }
  return out;
}

/**
 * Every `<DropdownMenuLabel` must sit inside an OPEN `<DropdownMenuGroup>` that
 * began after the enclosing `<DropdownMenuContent`.
 *
 * Tracked by walking the tags in source order and keeping a depth counter,
 * which is enough to catch the real mistake — a label dropped straight into the
 * content — without pretending to understand JSX.
 */
function ungroupedLabels(source: string): number[] {
  const pattern = /<(DropdownMenuContent|DropdownMenuGroup|DropdownMenuRadioGroup)[\s>]|<\/(DropdownMenuGroup|DropdownMenuRadioGroup)>|<(DropdownMenuLabel)[\s>]/g;
  const offenders: number[] = [];
  let depth = 0;
  for (const match of source.matchAll(pattern)) {
    if (match[1] === "DropdownMenuContent") depth = 0;
    else if (match[1]) depth += 1;
    else if (match[2]) depth = Math.max(0, depth - 1);
    else if (match[3] && depth === 0) {
      offenders.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return offenders;
}

describe("dropdown menu labels", () => {
  test("the scan catches a label dropped straight into the content", () => {
    // The exact shape that shipped, so a change to the scan that stopped
    // catching it fails here rather than silently going quiet.
    expect(
      ungroupedLabels(`<DropdownMenuContent><DropdownMenuLabel>Reasoning</DropdownMenuLabel></DropdownMenuContent>`),
    ).toHaveLength(1);
    expect(
      ungroupedLabels(
        `<DropdownMenuContent><DropdownMenuGroup><DropdownMenuLabel>Reasoning</DropdownMenuLabel></DropdownMenuGroup></DropdownMenuContent>`,
      ),
    ).toEqual([]);
    // A label after a group has CLOSED is back at depth zero, and is the
    // regression this would otherwise miss.
    expect(
      ungroupedLabels(
        `<DropdownMenuContent><DropdownMenuGroup><DropdownMenuItem /></DropdownMenuGroup><DropdownMenuLabel>Access</DropdownMenuLabel></DropdownMenuContent>`,
      ),
    ).toHaveLength(1);
  });

  test("no component ships a label outside a group", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(componentsRoot)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("<DropdownMenuLabel")) continue;
      for (const line of ungroupedLabels(source)) {
        offenders.push(`${path.relative(componentsRoot, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
