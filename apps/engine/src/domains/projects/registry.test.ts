import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { engineRootFromEnv } from "../../platform/fs/engine-root";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

test("project roots are canonical existing directories and legacy homes are rejected through symlinks", () => {
  const stateRoot = root();
  const store = new EngineStore(stateRoot);
  expect(() => store.projectRegistry.register({ id: "missing", name: "Missing", root: path.join(stateRoot, "missing") })).toThrow(/existing directory/);
  const link = path.join(stateRoot, "project-link");
  fs.symlinkSync("/tmp", link);
  expect(store.projectRegistry.register({ id: "canonical", name: "Canonical", root: link }).root).toBe(fs.realpathSync.native("/tmp"));

  // The legacy home must exist for the symlink half to mean anything (a dangling link never
  // resolves to it). Created only if absent and removed with rmdir, so a real one is never touched.
  const legacy = path.join(os.homedir(), ".telar");
  const createdLegacy = !fs.existsSync(legacy);
  if (createdLegacy) fs.mkdirSync(legacy, { recursive: true });
  try {
    const alias = path.join(stateRoot, "legacy-link");
    fs.symlinkSync(legacy, alias);
    expect(() => engineRootFromEnv({ TELAR_HOME: legacy })).toThrow(/legacy Telar state/);
    expect(() => engineRootFromEnv({ TELAR_HOME: alias })).toThrow(/legacy Telar state/);
  } finally {
    if (createdLegacy) fs.rmdirSync(legacy);
  }
});
