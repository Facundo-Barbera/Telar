/**
 * THIS WORKSPACE'S OWN REGISTRATION, ASSERTED HERE (#740).
 *
 * bun reads bunfig.toml from the directory it was invoked in and does not walk
 * up, so apps/web/bunfig.toml carries its own copy of every preload the root
 * registers — and a copy is a thing that can fall out of step silently. The
 * mechanism itself is proved in apps/engine/test/test-ceiling.test.ts, including
 * that it governs a bare `bun test <path>` from the repo root; what cannot be
 * proved from there is that THIS workspace's list still reaches it. Hence one
 * assertion, in the suite CI runs from apps/web.
 *
 * This workspace was the worse of the two the ceiling went missing from: a bare
 * root invocation dropped NODE_ENV=test along with it, which is #293's failure
 * on top of a timeout nobody could see.
 */
// @ts-expect-error Bun test types are provided by the test runner.
import { expect, test } from "bun:test";

const ceilingFromPreload = (globalThis as { __telarTestCeilingMs?: number }).__telarTestCeilingMs;

test("the per-test ceiling preload is registered for this workspace", () => {
  expect(ceilingFromPreload).toBeGreaterThan(5_000);
});

/**
 * NOT `toBe("test")`: scripts/test-setup.mjs rewrites only an inherited
 * "production", on the stated grounds that any other value was asked for
 * deliberately. The guarantee to assert is therefore the one that file actually
 * makes — never production — and asserting more would make this fail on a run
 * somebody meant.
 */
test("and nothing here renders against React's production build", () => {
  expect(process.env.NODE_ENV).not.toBe("production");
});
