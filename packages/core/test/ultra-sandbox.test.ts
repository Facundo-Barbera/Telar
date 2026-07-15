import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { compileScript, deterministicGlobals } from "../src/ultra/sandbox";

const META = `export const meta = { name: "t", description: "d", phases: ["a"] };`;

describe("Ultra sandbox — hygiene lint (a determinism aid, NOT a security control)", () => {
  test("a banned identifier is rejected with a structured {error,kind,detail,line}", () => {
    const code = `${META}\nexport default async function ({ log }) {\n  const x = require("fs");\n  return x;\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.kind).toBe("banned-identifier");
    expect(r.detail).toBe("require");
    expect(r.line).toBe(3);
    expect(typeof r.error).toBe("string");
  });

  test("each banned identifier trips the lint", () => {
    for (const id of ["require", "import", "process", "Date", "Math.random"]) {
      const code = `${META}\nexport default async function (s) { return ${id}; }`;
      const r = compileScript(code);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("banned-identifier");
    }
  });

  test("a banned WORD inside a string/comment (meta.description) does NOT trip the lint", () => {
    const code = `export const meta = { name: "t", description: "summarize by Date and process" };\n// require this later\nexport default async function (s) { return 1; }`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });
});

describe("Ultra sandbox — PRE-RUN static model lint (doc §4, best-effort)", () => {
  test("an agent() call with no options argument is rejected, naming the call site", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  return await agent("hello");\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.kind).toBe("missing-model");
    expect(r.line).toBe(3);
    expect(r.error).toContain("line 3");
    expect(r.error).toContain('agent("hello")');
  });

  test("an agent() call whose opts object literal has no `model` key is rejected", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  return await agent("hello", { label: "x" });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.kind).toBe("missing-model");
    expect(r.detail).toContain('label: "x"');
  });

  test("an agent() call with a top-level model key compiles fine", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  return await agent("hello", { model: "sonnet", label: "x" });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });

  test("an agent() call with an ES6 shorthand `{ model }` property compiles fine", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  const model = "sonnet";\n  return await agent("hello", { model, label: "x" });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });

  test("an agent() call with shorthand `model` as the last property compiles fine", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  const model = "sonnet";\n  return await agent("hello", { label: "x", model });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });

  test("a shorthand-lookalike key (`modelName`) does NOT satisfy the model check", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  const modelName = "sonnet";\n  return await agent("hello", { modelName, label: "x" });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("missing-model");
  });

  test("a NESTED object's own `model` key (e.g. inside a schema literal) does NOT satisfy the top-level check", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  return await agent("hello", { label: "x", schema: { shape: { model: 1 } } });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("missing-model");
  });

  test("multiple agent() calls: the FIRST offending call site is reported", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  await agent("ok", { model: "sonnet" });\n  await agent("bad", { label: "y" });\n  return null;\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(4);
      expect(r.detail).toContain('"bad"');
    }
  });

  test("an opts argument that isn't a literal object (a variable) is a blind spot — not rejected", () => {
    const code = `${META}\nexport default async function ({ agent }) {\n  const opts = { model: "sonnet" };\n  return await agent("hello", opts);\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });

  test("a property-access call (not the bare injected agent()) is skipped, not rejected", () => {
    const code = `${META}\nexport default async function (surface) {\n  return await surface.agent("hello", { label: "x" });\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });

  test("a script that never calls agent() at all is unaffected", () => {
    const code = `${META}\nexport default async function ({ log }) {\n  log("no agents here");\n  return 1;\n}`;
    const r = compileScript(code);
    expect(r.ok).toBe(true);
  });
});

describe("Ultra sandbox — meta is a PURE literal, statically read", () => {
  test("a pure object literal compiles and is returned verbatim", () => {
    const r = compileScript(`${META}\nexport default async function (s) { return 1; }`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta).toEqual({ name: "t", description: "d", phases: ["a"] });
  });

  test("a computed meta (function call) is rejected as non-literal", () => {
    const code = `const build = () => ({ name: "t" });\nexport const meta = build();\nexport default async function (s) { return 1; }`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("meta-not-literal");
  });

  test("a meta referencing an out-of-scope identifier is rejected", () => {
    const code = `export const meta = { name: NAME };\nexport default async function (s) { return 1; }`;
    const r = compileScript(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("meta-not-literal");
  });

  test("a missing meta is rejected", () => {
    const r = compileScript(`export default async function (s) { return 1; }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("no-meta");
  });

  test("a missing default export is rejected", () => {
    const r = compileScript(META);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("no-default");
  });
});

describe("Ultra sandbox — determinism stubs (defense-in-depth behind the lint)", () => {
  // The stubs are the real defense: a script that reaches Date via dynamic
  // access ("Da"+"te") slips past the lint but still throws at runtime.
  const ctx = vm.createContext(deterministicGlobals());

  test("Date.now() throws inside the context", () => {
    expect(() => new vm.Script("Date.now()").runInContext(ctx)).toThrow(/banned/);
  });

  test("new Date() throws inside the context", () => {
    expect(() => new vm.Script("new Date()").runInContext(ctx)).toThrow(/banned/);
  });

  test("Math.random() throws but the rest of Math is preserved", () => {
    expect(() => new vm.Script("Math.random()").runInContext(ctx)).toThrow(/banned/);
    expect(new vm.Script("Math.floor(3.7) + Math.max(1, 2)").runInContext(ctx)).toBe(5);
  });

  test("require/process are simply absent (ReferenceError, not a stub)", () => {
    expect(() => new vm.Script("typeof require === 'undefined' ? undefined : require").runInContext(ctx)).not.toThrow();
    expect(new vm.Script("typeof process").runInContext(ctx)).toBe("undefined");
  });
});
