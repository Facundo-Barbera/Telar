import { expect, test } from "bun:test";
import { assertTelarToolNames } from "@telar/engine-client";
import type { LatexCapability } from "../src/latex/capability";
import { latexTools } from "../src/latex/latex-tools";
import { TECTONIC_PACKAGES_NOTE } from "../src/latex/packages";
import type { ToolFactory } from "../src/tool-kit";

type Registered = { name: string; description: string; run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> };

function build(capability: Partial<LatexCapability>): Registered[] {
  const tools: Registered[] = [];
  const factory: ToolFactory = (name, description, _shape, handler) => {
    tools.push({ name, description, run: handler });
    return { name };
  };
  const refuse = async () => { throw new Error("not in this test"); };
  const full = new Proxy({} as LatexCapability, { get: (_, prop) => (capability as Record<string | symbol, unknown>)[prop] ?? refuse });
  latexTools(factory, full);
  return tools;
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

test("every latex_* tool carries the declared capability prefix", () => {
  const names = build({}).map((t) => t.name);
  expect(names).toHaveLength(7);
  expect(() => assertTelarToolNames(names)).not.toThrow();
});

test("latex_compile reports the PDF on success and the diagnostics on failure", async () => {
  const tools = build({
    compile: async (input) => ({
      ok: !input?.path?.includes("bad"),
      path: input?.path ?? "main.tex",
      pdfPath: "main.pdf",
      diagnostics: input?.path?.includes("bad")
        ? [{ severity: "error" as const, file: "bad.tex", line: 3, message: "Undefined control sequence.", suggestion: "check the macro" }]
        : [],
      logTail: ["Output written on main.pdf"],
    }),
  });
  const compile = tools.find((t) => t.name === "latex_compile")!;
  const good = await compile.run({});
  expect(good.isError).toBeUndefined();
  expect(text(good)).toContain("main.pdf");
  const bad = await compile.run({ path: "bad.tex" });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("bad.tex:3");
  expect(text(bad)).toContain("Undefined control sequence.");
  expect(text(bad)).toContain("check the macro");
});

test("latex_install relays the tectonic refusal sentence as an error", async () => {
  const tools = build({ install: async () => ({ ok: false, lines: [], error: TECTONIC_PACKAGES_NOTE }) });
  const result = await tools.find((t) => t.name === "latex_install")!.run({ add: ["siunitx"] });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("automatically");
});

test("latex_packages renders each answer mode honestly", async () => {
  const automatic = build({ packages: async () => ({ mode: "automatic", note: TECTONIC_PACKAGES_NOTE }) });
  expect(text(await automatic.find((t) => t.name === "latex_packages")!.run({}))).toBe(TECTONIC_PACKAGES_NOTE);
  const unavailable = build({ packages: async () => ({ mode: "unavailable", reason: "this TeX Live is root-owned" }) });
  const refused = await unavailable.find((t) => t.name === "latex_packages")!.run({});
  expect(refused.isError).toBe(true);
  const managed = build({ packages: async () => ({ mode: "managed", packages: [{ name: "siunitx", revision: "64123" }] }) });
  expect(text(await managed.find((t) => t.name === "latex_packages")!.run({}))).toContain("siunitx (r64123)");
});

test("latex_status says so before the first compile", async () => {
  const tools = build({ status: async () => ({ status: "never" as const }) });
  expect(text(await tools.find((t) => t.name === "latex_status")!.run({}))).toContain("Nothing has been compiled");
});

test("a capability failure comes back as a sentence, not a crash", async () => {
  const tools = build({});
  const result = await tools.find((t) => t.name === "latex_toolchain")!.run({});
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("not in this test");
});
