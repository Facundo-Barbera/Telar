import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../../platform/db/execution-store";
import { runDiagnosisTool } from "./diagnosis-access";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-outside-"));
  const write = (relative: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  write("projects.json", '{"projects":[{"name":"alpha"}]}\nsecond line');
  write("diagnostics/usage/d1/digest.json", '{"signals":[]}');
  write("provider-secrets.json", '{"key":"sk-live-SECRET"}');
  write("usage-limit-secrets.json", '{"hub":"SECRET"}');
  write("dictation/credentials.json", '{"deepgram":"SECRET"}');
  write("browser-profiles/default/Cookies", "SECRET");
  write("engine.json", '{"token":"SECRET"}');
  write("sessions-mcp-secret.json", "SECRET");
  fs.writeFileSync(path.join(outside, "elsewhere.txt"), "SECRET outside");
  fs.symlinkSync(path.join(outside, "elsewhere.txt"), path.join(root, "link.txt"));
  fs.mkdirSync(path.join(root, "sessions"));
  const store = new ExecutionStore(root);
  store.statement("INSERT INTO metadata (key, value) VALUES ('probe', 'hello')").run();
  store.close();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const run = (tool: "read" | "grep" | "glob" | "sql", args: Record<string, unknown>) => runDiagnosisTool(root, tool, args);

test("reads ordinary files with line numbers and lists folders", () => {
  expect(run("read", { path: "projects.json" })).toBe('1\t{"projects":[{"name":"alpha"}]}\n2\tsecond line');
  expect(run("read", { path: "projects.json", offset: 1, limit: 1 })).toBe("2\tsecond line");
  expect(run("read", { path: "." }).split("\n")).toEqual(expect.arrayContaining(["projects.json", "diagnostics/"]));
});

test("refuses every secret-bearing file, whether named directly or reached by search", () => {
  for (const secret of ["provider-secrets.json", "usage-limit-secrets.json", "dictation/credentials.json", "browser-profiles/default/Cookies", "engine.json", "sessions-mcp-secret.json"]) {
    expect(() => run("read", { path: secret })).toThrow(/secrets/);
  }
  expect(run("read", { path: "." })).not.toContain("provider-secrets.json");
  expect(run("grep", { pattern: "SECRET" })).toBe("no matches");
  expect(run("glob", { pattern: "**/*" })).not.toMatch(/secret|credentials|Cookies|engine\.json/i);
});

test("stays inside the data folder: no parent paths, absolute paths or symlinks out", () => {
  expect(() => run("read", { path: "../" })).toThrow(/data folder/);
  expect(() => run("read", { path: path.join(outside, "elsewhere.txt") })).toThrow(/data folder/);
  expect(() => run("read", { path: "link.txt" })).toThrow(/data folder/);
  expect(run("grep", { pattern: "outside" })).toBe("no matches");
});

test("greps and globs ordinary files", () => {
  expect(run("grep", { pattern: "alpha" })).toBe('projects.json:1:{"projects":[{"name":"alpha"}]}');
  expect(run("glob", { pattern: "diagnostics/**/*.json" })).toBe("diagnostics/usage/d1/digest.json\t14");
});

test("the database is read through sql only, and only with a single SELECT", () => {
  expect(() => run("read", { path: "execution.sqlite" })).toThrow(/sql tool/);
  expect(JSON.parse(run("sql", { query: "SELECT value FROM metadata WHERE key = 'probe';" }))).toEqual({ rows: [{ value: "hello" }] });
  expect(JSON.parse(run("sql", { query: "SELECT replace('drop table', 'drop', 'x') AS v" }))).toEqual({ rows: [{ v: "x table" }] });
  for (const query of [
    "DELETE FROM metadata",
    "UPDATE metadata SET value = 'x'",
    "SELECT 1; DELETE FROM metadata",
    "WITH x AS (SELECT 1) INSERT INTO metadata SELECT 'a','b' FROM x",
    "ATTACH DATABASE '/tmp/x.sqlite' AS x",
    "PRAGMA journal_mode=DELETE",
    "SELECT load_extension('evil')",
  ]) {
    expect(() => run("sql", { query })).toThrow();
  }
  expect(JSON.parse(run("sql", { query: "SELECT count(*) AS n FROM metadata WHERE key = 'probe'" }))).toEqual({ rows: [{ n: 1 }] });
});
