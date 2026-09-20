/**
 * THE VIEWER ACTUALLY DRAWS THE PATCH — issue #694.
 *
 * Telar stopped writing a diff renderer and started adapting one, and the
 * failure mode of an adapter is different from the failure mode of a renderer:
 * nothing here can be wrong about how a `+` line is coloured, and everything
 * here can be wrong about whether an option reached the component. So these
 * mount the real `@pierre/diffs` viewer and read what came out of it, rather
 * than asserting that this file passes a string to a library.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE WRITING ANOTHER TEST HERE: the viewer measures 0×0 under
 * happy-dom and renders NO LINE CONTENT without `stubLayout()` below.
 *
 * It virtualizes — it asks its scroll container how tall it is and draws the
 * rows that fall inside. happy-dom answers 0 for every box, so the honest
 * result is a file with no visible rows: you get the chrome and nothing else.
 * That looks exactly like a broken viewer and is not one. Stub the layout and
 * the lines appear.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE MARKUP IS INSIDE A SHADOW ROOT, so `document.body.innerHTML` never shows
 * it. `shadowRoot.innerHTML` is where the assertions look, and Pierre's own
 * `data-*` attributes are what they look for — those are its public surface,
 * the same one `.diff-code-view` in globals.css styles against.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiffCodeView, readPatchShape } from "./diff-code-view";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A viewport, because a virtualizer with no height draws no rows.
 *
 * Applied once to the prototypes rather than per element: the viewer measures
 * its container, its rows and its own host, and which of those it reaches for
 * is its business, not this test's.
 */
function stubLayout(): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}) };
  Element.prototype.getBoundingClientRect = () => rect as DOMRect;
  for (const [property, value] of [
    ["clientHeight", 600],
    ["offsetHeight", 600],
    ["clientWidth", 900],
    ["offsetWidth", 900],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => value });
  }
}

beforeAll(stubLayout);

const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const alpha = 1;
-const beta = 2;
+const beta = 3;
 const gamma = 4;
`;

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

/**
 * HAND THE DOM BACK, because the registration is PROCESS-WIDE and this suite
 * shares its process with every other `.test.tsx` under apps/web.
 *
 * `GlobalRegistrator.register` throws on a second call — "Happy DOM has already
 * been globally registered" — and it is the NEXT file to register that dies, not
 * this one. So a missing unregister here is not a leak that costs this suite
 * anything; it is a landmine for whichever file bun happens to load afterwards,
 * and it reads as that file's failure. Every other registering file in this app
 * pairs the two for exactly this reason.
 */
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Mounts the viewer and hands back what its shadow root holds. The wait is for
 * Pierre's own async tokenise-and-render, not for a timer of ours.
 *
 * `markup` AND `text` ARE BOTH NEEDED, and which to reach for is the whole
 * trick of reading a highlighted render: the viewer emits ONE SPAN PER TOKEN,
 * so `const beta = 2;` never appears as a substring of the HTML — it is five
 * elements. Assert content against `text`, and structure against `markup`.
 */
async function render(props: {
  layout: "stacked" | "split";
  wrap: boolean;
}): Promise<{ host: Element; markup: string; text: string; columns: number }> {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  roots.push(root);
  await act(async () => {
    root.render(<DiffCodeView patch={PATCH} layout={props.layout} wrap={props.wrap} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const host = mount.firstElementChild!;
  const shadow = (host as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
  // `[data-content]` is one column of code. Stacked has one; SPLIT HAS TWO —
  // deletions then additions — which is the structural difference between the
  // two layouts and the thing worth asserting about them.
  const content = [...(shadow?.querySelectorAll("[data-content]") ?? [])];
  return {
    host,
    markup: String(shadow?.innerHTML ?? ""),
    text: content.map((column) => column.textContent ?? "").join("\n"),
    columns: content.length,
  };
}

describe("the diff viewer", () => {
  test("draws the patch's lines, both sides of the change", async () => {
    // The point of adopting a library rather than writing one: this is a real
    // tokenised, virtualized render, and the text in it is the patch's.
    const { markup, text } = await render({ layout: "stacked", wrap: false });
    expect(markup).toContain("data-line");
    expect(text).toContain("const beta = 2;");
    expect(text).toContain("const beta = 3;");
    // Context survives too — a diff with only its changed lines is a worse
    // diff, and `--unified=3` on the engine side is what pays for these.
    expect(text).toContain("const alpha = 1;");
    // Highlighted, not plain: the tokens carry BOTH schemes, which is what
    // makes a Look change a variable flip rather than a re-tokenise. Same
    // mechanism `lib/highlight.ts` documents at `defaultColor: false`.
    expect(markup).toContain("--diffs-token-light");
    expect(markup).toContain("--diffs-token-dark");
  });

  test("carries the class the app themes it through", async () => {
    // `.diff-code-view` in globals.css is the WHOLE of the theming — custom
    // properties inherit through the shadow boundary, so losing this class
    // loses every colour at once, silently, in a component whose own defaults
    // look perfectly fine.
    const { host } = await render({ layout: "stacked", wrap: false });
    expect(host.className).toContain("diff-code-view");
  });

  test("the file header is Telar's row, not the viewer's own", async () => {
    // Two headers would be two answers to "which file is this", and only one of
    // them knows whether the transcript mentioned it.
    const { markup } = await render({ layout: "stacked", wrap: false });
    expect(markup).not.toContain("data-diffs-header");
  });

  test("Stacked and Split are two layouts, not one with a different width", async () => {
    // Pierre marks its own choice on the code element; asserting the attribute
    // rather than counting columns is what keeps this a test of the OPTION
    // reaching the viewer, which is the only part this file owns.
    const stacked = await render({ layout: "stacked", wrap: false });
    const split = await render({ layout: "split", wrap: false });
    expect(stacked.markup).toContain("data-unified");
    expect(split.markup).not.toContain("data-unified");
    // And the structural difference underneath the attribute: stacked lays the
    // two sides in ONE column, one above the other; split gives each its own.
    expect(stacked.columns).toBe(1);
    expect(split.columns).toBe(2);
    // Both sides are present either way — the layout moves the lines, it does
    // not choose which of them you are shown.
    for (const laid of [stacked, split]) {
      expect(laid.text).toContain("const beta = 2;");
      expect(laid.text).toContain("const beta = 3;");
    }
  });

  test("word wrap off means the line scrolls, which is the decision (#694)", async () => {
    // Off by default and NOT gated on width: wrapping destroys the column
    // alignment that makes a split diff readable, and a long line scrolls.
    const off = await render({ layout: "stacked", wrap: false });
    const on = await render({ layout: "stacked", wrap: true });
    expect(off.markup).toContain('data-overflow="scroll"');
    expect(on.markup).toContain('data-overflow="wrap"');
  });
});

/**
 * THE SEAM THE REST OF #694's CORRECTNESS PASS IS CHECKED AGAINST.
 *
 * Every test above renders a WELL-FORMED patch and finds its lines, and every
 * defect the investigation listed passes all of them — because the library
 * recovers from malformed input with a `console.error` nobody sees. These ask
 * the parser the question directly, in BOTH directions on the same test: a good
 * patch must produce no complaint, or "there was a complaint" proves nothing.
 */
describe("what the parser made of the patch (#694)", () => {
  test("a well-formed patch reads cleanly, as one file, with its hunks", () => {
    const reading = readPatchShape(PATCH);
    expect(reading.complaint).toBeUndefined();
    expect(reading.files).toBe(1);
    expect(reading.file?.name).toBe("a.ts");
    expect(reading.file?.hunks).toBe(1);
    expect(reading.file?.type).toBe("change");
  });

  test("a patch cut off mid-hunk is a complaint, not a shorter patch", () => {
    // What the engine's 1 MiB bound produces, and what used to render as a
    // complete change: the declared hunk length and the lines present disagree.
    const reading = readPatchShape(`diff --git a/big.txt b/big.txt
index 1111111..2222222 100644
--- a/big.txt
+++ b/big.txt
@@ -1,9 +1,9 @@
 const alpha = 1;
-const beta = 2;
+const beta = 3;
-const gam`);
    expect(reading.complaint).toBeDefined();
    expect(reading.complaint).toContain("hunk");
  });

  test("a truncation marker inside the patch is a complaint, not a line", () => {
    // `diff.ts` announced truncation IN the patch, which the old `<pre>` printed
    // and this parser drops as unreadable — so the marker stopped arriving the
    // day the renderer changed (#694, §2.5).
    const reading = readPatchShape(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,4 @@
-old
+new
… diff truncated at 12000 characters …`);
    expect(reading.complaint).toBeDefined();
  });

  test("a patch that reaches two files is counted as two", () => {
    // A pathspec that matched a neighbour (#694, §2.6). The engine no longer
    // produces one; the count is what lets a row SAY SO if anything ever does.
    const reading = readPatchShape(`diff --git a/brack1.ts b/brack1.ts
--- a/brack1.ts
+++ b/brack1.ts
@@ -1 +1,2 @@
 x
+GLOBBED
diff --git a/brack[1].ts b/brack[1].ts
--- a/brack[1].ts
+++ b/brack[1].ts
@@ -1 +1,2 @@
 y
+LITERAL
`);
    expect(reading.complaint).toBeUndefined();
    expect(reading.files).toBe(2);
    expect(reading.file).toBeUndefined();
  });

  test("the shapes with no hunks are read, not refused", () => {
    // Mode-only and pure-rename patches are VALID and carry no hunks at all.
    // A seam that called them malformed would put a warning over every
    // `chmod +x` in the repository.
    const mode = readPatchShape("diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n");
    expect(mode.complaint).toBeUndefined();
    expect(mode.file).toMatchObject({ mode: "100755", prevMode: "100644", hunks: 0 });

    const renamed = readPatchShape("diff --git a/src.txt b/dst.txt\nsimilarity index 100%\nrename from src.txt\nrename to dst.txt\n");
    expect(renamed.complaint).toBeUndefined();
    expect(renamed.file).toMatchObject({ name: "dst.txt", prevName: "src.txt", hunks: 0 });
    expect(renamed.file?.type).toStartWith("rename-");
  });
});
