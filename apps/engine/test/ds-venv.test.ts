import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { createProjectVenv } from "../src/ds/telar-venv";
import type { Exec } from "../src/ds/python-env";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ds-venv-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** An exec that fakes uv: `venv` makes a bin/python, `pip install` succeeds. */
function fakeUv(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "uv" && args[0] === "--version") return { status: 0, stdout: "uv 0.12\n", stderr: "" };
    if (file === "uv" && args[0] === "venv") {
      const dir = args[args.length - 1]!;
      fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
      fs.writeFileSync(path.join(dir, "bin", "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === "uv" && args[0] === "pip") return { status: 0, stdout: "", stderr: "" };
    return { status: 127, stdout: "", stderr: "not scripted" };
  };
  return { exec, calls };
}

test("createProjectVenv makes .venv in the checkout, installs only the stack, and refuses to overwrite", async () => {
  const project = root();
  const { exec, calls } = fakeUv();
  const first = await createProjectVenv(project, { basePython: "/usr/bin/python3", stack: true, exec });
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.python).toBe(path.join(project, ".venv", "bin", "python"));
  const install = calls.find((c) => c[1] === "pip");
  expect(install).toBeDefined();
  expect(install!.join(" ")).not.toContain("ipykernel");
  expect(install!.join(" ")).toContain("pandas");

  const again = await createProjectVenv(project, { basePython: "/usr/bin/python3", exec });
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.reason).toContain("already exists");
});

test("the store gitignores a created .venv and relativises its path", async () => {
  const project = root();
  fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");
  const store = new EngineStore(root(), () => 100);
  store.registerProject({ id: "project_v", name: "V", root: project });
  // The store's exec is the real one; stub uv on PATH with a script that does what the fake does.
  const bin = root();
  fs.writeFileSync(path.join(bin, "uv"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "uv 0.12"; exit 0; fi
if [ "$1" = "venv" ]; then d="\${@: -1}"; mkdir -p "$d/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$d/bin/python"; chmod +x "$d/bin/python"; exit 0; fi
if [ "$1" = "pip" ]; then exit 0; fi
exit 127
`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    // The base must probe ok; a real python3 does.
    const base = "/usr/bin/python3";
    if (!fs.existsSync(base)) return;
    const outcome = await store.dataScienceCreateProjectVenv("project_v", { basePython: base });
    expect(outcome.ok).toBe(true);
    expect(outcome.relativePath).toBe(path.join(".venv", "bin", "python"));
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".venv/");
  } finally {
    process.env.PATH = previous;
  }
});

test("dataScienceProbe accepts a venv directory as well as a binary, and reports an unusable one", async () => {
  const project = root();
  const store = new EngineStore(root(), () => 100);
  store.registerProject({ id: "project_p", name: "P", root: project });
  const missing = await store.dataScienceProbe("project_p", ".venv");
  expect(missing.ok).toBe(false);
  if (fs.existsSync("/usr/bin/python3")) {
    const found = await store.dataScienceProbe("project_p", "/usr/bin/python3");
    expect(found.ok).toBe(true);
    expect(found.relativePath).toBe("/usr/bin/python3");
  }
});
