import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EngineStateError } from "../kernel";
import { engineRootFromEnv, migrateLegacyEngineRoot } from "./engine-root";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

test("the engine requires an explicit absolute home and writes only beneath its Telar root", () => {
  expect(() => engineRootFromEnv({})).toThrow(EngineStateError);
  expect(() => engineRootFromEnv({ TELAR_HOME: "relative" })).toThrow(EngineStateError);
  expect(engineRootFromEnv({ TELAR_HOME: "/tmp/telar" })).toBe(path.join(fs.realpathSync.native("/tmp"), "telar", "engine"));
  const { root: stateRoot } = readyStore();
  expect(fs.existsSync(path.join(stateRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(stateRoot), "chats.json"))).toBe(false);
});

describe("the store survives being renamed out of vnext/", () => {
  // Without the rename from `<TELAR_HOME>/vnext`, the daemon would come up healthy on an empty root, with
  // every project and session silently gone.
  test("an existing vnext/ store is renamed into place", () => {
    const home = root();
    const legacy = path.join(home, "vnext");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(true);
    expect(fs.existsSync(path.join(home, "engine", "projects.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  test("a store already in place is never overwritten by a stale vnext/", () => {
    // Both names existing means somebody ran an old build after a new one. The
    // CURRENT root wins; renaming over it would replace live state with older
    // state, which is worse than the leftover directory.
    const home = root();
    fs.mkdirSync(path.join(home, "vnext"), { recursive: true });
    fs.mkdirSync(path.join(home, "engine"), { recursive: true });
    fs.writeFileSync(path.join(home, "engine", "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(false);
    expect(fs.existsSync(path.join(home, "vnext"))).toBe(true);
  });

  test("nothing to migrate is not an error, and says nothing", () => {
    expect(migrateLegacyEngineRoot(path.join(root(), "engine"))).toBe(false);
  });

  test("a root explicitly pinned AT the old name is left exactly where it is", () => {
    // Tests and anyone who passed `--engine-root .../vnext` by hand. Renaming a
    // directory onto itself is either a no-op or a crash, depending on the
    // platform; neither is something to find out at somebody's boot.
    const home = root();
    const pinned = path.join(home, "vnext");
    fs.mkdirSync(pinned, { recursive: true });
    expect(migrateLegacyEngineRoot(pinned)).toBe(false);
    expect(fs.existsSync(pinned)).toBe(true);
  });
});
