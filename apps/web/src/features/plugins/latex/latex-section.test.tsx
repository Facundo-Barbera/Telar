// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectPlugins } from "@telar/engine-client";
import { EngineSelect, MainFileSelect, inheritedDistribution } from "./latex-section";

/**
 * THE SENTINEL IS NOT A LABEL (#352) — the same bug #318 fixed for the scope
 * select, found again on this page. "No default" is carried as `__none`, and
 * base-ui's `Select.Value` renders the raw VALUE when nothing maps it to a
 * label, so the trigger read `__none` while the list beside it read "No
 * default" the whole time.
 */
test("with no default chosen the trigger reads 'No default', never the sentinel", () => {
  const html = renderToStaticMarkup(<MainFileSelect candidates={["paper/main.tex"]} onPick={() => {}} />);
  // The trigger's own value element. base-ui also renders a hidden form input
  // carrying the real value, which is right — so this pins the visible span.
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">No default<');
});

test("with a document chosen the trigger reads the path", () => {
  const html = renderToStaticMarkup(<MainFileSelect value="paper/main.tex" candidates={["paper/main.tex"]} onPick={() => {}} />);
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">paper/main.tex<');
});

/**
 * THE PROJECT ROWS ARE OVERRIDES OF THIS MAC'S DEFAULT. With nothing chosen for
 * the project, the engine resolves the Mac's value (`resolveLatex`), so the
 * rows name it rather than showing an independent value or a blank.
 */
describe("with nothing chosen, the project rows name what they inherit", () => {
  const machine = (settings: Record<string, unknown>) => ({ entries: { latex: { enabled: true, settings } } }) as unknown as ProjectPlugins;
  const toolchain = {
    texlive: [{ binDir: "/Library/TeX/texbin", flavour: "mactex" as const, year: "2025" }],
    managed: { version: "0.15.0", supported: true, installed: true, installing: false },
  };

  test("the distribution reads the Mac's default", () => {
    expect(inheritedDistribution(machine({ toolchain: { kind: "managed" } }), toolchain)).toBe("Inherit (Telar (managed))");
    expect(inheritedDistribution(machine({ toolchain: { kind: "texlive", path: "/Library/TeX/texbin" } }), toolchain)).toBe("Inherit (MacTeX 2025)");
    // No Mac default: the chain falls through to Telar's own copy when it is there.
    expect(inheritedDistribution(machine({}), toolchain)).toBe("Inherit (Telar (managed))");
    expect(inheritedDistribution(machine({}), { texlive: [] })).toBe("Inherit (none)");
  });

  test("the engine trigger reads the Mac's engine until the project picks one", () => {
    const inherit = renderToStaticMarkup(<EngineSelect machine={machine({})} onPick={() => {}} />);
    expect(inherit).toContain('data-slot="select-value" class="flex flex-1 text-left">Inherit (pdfLaTeX)<');
    const mac = renderToStaticMarkup(<EngineSelect machine={machine({ engine: "xelatex" })} onPick={() => {}} />);
    expect(mac).toContain('data-slot="select-value" class="flex flex-1 text-left">Inherit (XeLaTeX)<');
    const own = renderToStaticMarkup(<EngineSelect value="lualatex" machine={machine({ engine: "xelatex" })} onPick={() => {}} />);
    expect(own).toContain('data-slot="select-value" class="flex flex-1 text-left">lualatex<');
  });
});
