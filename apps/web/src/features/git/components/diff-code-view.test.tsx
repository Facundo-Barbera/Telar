// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiffCodeView, readPatchShape } from "./diff-code-view";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

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
    const { markup, text } = await render({ layout: "stacked", wrap: false });
    expect(markup).toContain("data-line");
    expect(text).toContain("const beta = 2;");
    expect(text).toContain("const beta = 3;");
    expect(text).toContain("const alpha = 1;");
    expect(markup).toContain("--diffs-token-light");
    expect(markup).toContain("--diffs-token-dark");
  });

  test("carries the class the app themes it through", async () => {
    const { host } = await render({ layout: "stacked", wrap: false });
    expect(host.className).toContain("diff-code-view");
  });

  test("the file header is Telar's row, not the viewer's own", async () => {
    const { markup } = await render({ layout: "stacked", wrap: false });
    expect(markup).not.toContain("data-diffs-header");
  });

  test("Stacked and Split are two layouts, not one with a different width", async () => {
    const stacked = await render({ layout: "stacked", wrap: false });
    const split = await render({ layout: "split", wrap: false });
    expect(stacked.markup).toContain("data-unified");
    expect(split.markup).not.toContain("data-unified");
    expect(stacked.columns).toBe(1);
    expect(split.columns).toBe(2);
    for (const laid of [stacked, split]) {
      expect(laid.text).toContain("const beta = 2;");
      expect(laid.text).toContain("const beta = 3;");
    }
  });

  test("word wrap off means the line scrolls, which is the decision (#694)", async () => {
    const off = await render({ layout: "stacked", wrap: false });
    const on = await render({ layout: "stacked", wrap: true });
    expect(off.markup).toContain('data-overflow="scroll"');
    expect(on.markup).toContain('data-overflow="wrap"');
  });
});

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

  test("a journal patch is a CHANGE, not a rename of a/x.ts to b/x.ts (#694, §2.4)", () => {
    const withHeader = readPatchShape(["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"));
    expect(withHeader.complaint).toBeUndefined();
    expect(withHeader.file).toMatchObject({ name: "x.ts", type: "change", hunks: 1 });
    expect(withHeader.file?.prevName).toBeUndefined();

    const without = readPatchShape(["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"));
    expect(without.file).toMatchObject({ name: "b/x.ts", prevName: "a/x.ts", type: "rename-changed" });

    const absolute = readPatchShape(["--- /tmp/x.ts", "+++ /tmp/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"));
    expect(absolute.complaint).toBeUndefined();
    expect(absolute.file).toMatchObject({ name: "/tmp/x.ts", type: "change" });
  });

  test("the shapes with no hunks are read, not refused", () => {
    const mode = readPatchShape("diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n");
    expect(mode.complaint).toBeUndefined();
    expect(mode.file).toMatchObject({ mode: "100755", prevMode: "100644", hunks: 0 });

    const renamed = readPatchShape("diff --git a/src.txt b/dst.txt\nsimilarity index 100%\nrename from src.txt\nrename to dst.txt\n");
    expect(renamed.complaint).toBeUndefined();
    expect(renamed.file).toMatchObject({ name: "dst.txt", prevName: "src.txt", hunks: 0 });
    expect(renamed.file?.type).toStartWith("rename-");
  });
});
