// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE LOOMS IDIOM, PINNED — the same move the Spool made with its own
 * idiom.test.ts, for the same reason: the looms place drifted into a
 * hand-rolled dialect in one afternoon because nothing said it couldn't.
 *
 * The rule is single-sentence: looms surfaces are COMPOSED from the app's
 * shared vocabulary, never re-drawn beside it. Each test below pins one
 * concrete way that rule was already broken once.
 */

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots = [path.join(appRoot, "app", "looms"), path.join(appRoot, "components", "loom")];

function sources(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

const files = roots.flatMap(sources).map((file) => ({ file: path.relative(appRoot, file), text: fs.readFileSync(file, "utf8") }));

describe("looms surfaces speak the app's design system", () => {
  test("no native <select> — the system Select exists and is the one select", () => {
    for (const { file, text } of files) {
      expect(text.includes("<select"), `${file} renders a native <select>`).toBe(false);
    }
  });

  test("no hand-rolled buttons — a bordered hover-bg <button> is Button's job", () => {
    // The exact dialect the first version spoke: `rounded border ... hover:bg-muted`
    // on a raw element. Real Buttons come from components/ui/button.
    for (const { file, text } of files) {
      expect(/<(?:button|Link)[^>]*className="[^"]*rounded border border-border[^"]*hover:bg-muted/.test(text), `${file} hand-rolls a button`).toBe(
        false,
      );
    }
  });

  test("no hand-rolled state chips — rounded-full border pills are Badge's job", () => {
    for (const { file, text } of files) {
      expect(/className="[^"]*rounded-full border[^"]*uppercase/.test(text), `${file} hand-rolls a state chip`).toBe(false);
    }
  });

  test("every looms page wears the app's chrome or the thread strip", () => {
    // Board, room, and weave room introduce themselves with PageHeader like
    // every top-level surface; the thread page's strip is the one sanctioned
    // exception because the cockpit below it brings its own titlebar.
    for (const name of ["app/looms/looms-board.tsx", "app/looms/[id]/loom-room.tsx", "app/looms/new/new-loom.tsx"]) {
      const found = files.find((f) => f.file === name);
      expect(found, `${name} missing`).toBeDefined();
      expect(found!.text.includes("PageHeader"), `${name} does not use PageHeader`).toBe(true);
    }
  });

  test("liveness is spoken in the session rows' language, not a local dialect", () => {
    // The one source: lib/session-activity's activityBadge/ACTIVITY_TONE, via
    // components/loom/thread-row. A surface painting its own status colours
    // from scratch is the drift this whole file exists to stop.
    for (const name of ["app/looms/looms-board.tsx", "app/looms/[id]/loom-room.tsx"]) {
      const found = files.find((f) => f.file === name)!;
      expect(found.text.includes("@/components/loom/thread-row"), `${name} does not use the shared thread vocabulary`).toBe(true);
    }
  });

  test("timestamps use the app's own words, never toLocale*", () => {
    for (const { file, text } of files) {
      expect(text.includes("toLocaleTimeString") || text.includes("toLocaleString"), `${file} formats time outside lib/format`).toBe(false);
    }
  });

  test("loading is Skeleton or Shimmer, never the word Loading", () => {
    for (const { file, text } of files) {
      expect(/["'>]Loading…/.test(text), `${file} renders a bare Loading string`).toBe(false);
    }
  });
});
