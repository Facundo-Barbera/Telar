import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../src/run/store";
import { redactConfiguration, RunError, secretValues, redactText } from "../src/run/types";

const tempDirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-store-"));
  tempDirs.push(dir);
  return dir;
};

/** Every store here is a real directory; none of them survives the file. */
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("a saved configuration survives a fresh reader", () => {
  const dir = tempDir();
  const created = new RunStore(dir).create("proj_1", { name: "web dev", command: "bun run dev", cwd: "apps/web" });

  const reread = new RunStore(dir).list("proj_1");
  expect(reread).toHaveLength(1);
  expect(reread[0]).toEqual(created);
  expect(reread[0]!.projectId).toBe("proj_1");
});

test("configurations are per project and do not leak across them", () => {
  const dir = tempDir();
  const store = new RunStore(dir);
  store.create("proj_1", { name: "web dev", command: "bun run dev" });
  store.create("proj_2", { name: "api", command: "uvicorn app:app" });

  expect(store.list("proj_1").map((c) => c.name)).toEqual(["web dev"]);
  expect(store.list("proj_2").map((c) => c.name)).toEqual(["api"]);
});

test("two configurations cannot share a name — a dropdown with two 'web dev' is a bug report", () => {
  const store = new RunStore(tempDir());
  store.create("proj_1", { name: "web dev", command: "bun run dev" });
  expect(() => store.create("proj_1", { name: " web dev ", command: "something else" })).toThrow(/already has a run configuration/);
});

test("editing keeps the id and moves updatedAt", () => {
  let clock = 1000;
  const store = new RunStore(tempDir(), () => (clock += 10));
  const created = store.create("proj_1", { name: "web dev", command: "bun run dev" });
  const updated = store.update("proj_1", created.id, { command: "bun run dev --turbo" });

  expect(updated.id).toBe(created.id);
  expect(updated.command).toBe("bun run dev --turbo");
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
});

test("a working directory that climbs out of the worktree is refused at save time", () => {
  const store = new RunStore(tempDir());
  expect(() => store.create("proj_1", { name: "sneaky", command: "ls", cwd: "../../etc" })).toThrow();
  expect(() => store.create("proj_1", { name: "absolute", command: "ls", cwd: "/etc" })).toThrow();
});

test("missing and unknown things are named, not invented", () => {
  const store = new RunStore(tempDir());
  expect(store.list("never_seen")).toEqual([]);
  expect(() => store.get("proj_1", "runcfg_nope")).toThrow(RunError);
  expect(() => store.remove("proj_1", "runcfg_nope")).toThrow(/no run configuration/);
});

test("a corrupt file refuses to read rather than offering an empty editor over live work", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "proj_1.json"), "{ not json");
  expect(() => new RunStore(dir).list("proj_1")).toThrow(/not valid JSON/);
});

test("secret values are stored for the launch and dropped from every read", () => {
  const store = new RunStore(tempDir());
  const config = store.create("proj_1", {
    name: "api",
    command: "bun run dev",
    env: [
      { key: "PORT", value: "3000" },
      { key: "STRIPE_KEY", value: "sk_live_supersecret", secret: true },
    ],
  });

  // The document keeps it — a launch needs the real value.
  expect(config.env?.find((e) => e.key === "STRIPE_KEY")?.value).toBe("sk_live_supersecret");

  const view = redactConfiguration(config);
  expect(view.env).toEqual([
    { key: "PORT", value: "3000" },
    { key: "STRIPE_KEY", secret: true },
  ]);
  expect(JSON.stringify(view)).not.toContain("sk_live_supersecret");
});

test("redaction replaces longer secrets first, so no tail of one survives", () => {
  const secrets = secretValues({ env: [{ key: "A", value: "abcd", secret: true }, { key: "B", value: "abcd1234", secret: true }] });
  expect(redactText("token=abcd1234 other=abcd", secrets)).toBe("token=«redacted» other=«redacted»");
});
