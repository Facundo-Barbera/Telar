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
