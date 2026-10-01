import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { OWN_GROUP, signalGroup, stopGroup } from "./group";

// The grandchild inherits stdout, so the leader's "close" fires only once the grandchild is gone too.
function shellWithGrandchild(grandchild: string) {
  const child = spawn("sh", ["-c", `(${grandchild}) & echo started; wait`], { detached: OWN_GROUP, stdio: ["ignore", "pipe", "ignore"] });
  return { child, exited: once(child, "exit"), closed: once(child, "close"), started: once(child.stdout, "data") };
}

test.skipIf(!OWN_GROUP)("signalGroup reaches the grandchild, not only the leader", async () => {
  const { child, exited, closed, started } = shellWithGrandchild("exec sleep 60");
  await started;
  signalGroup(child, "SIGTERM");
  expect((await exited)[1]).toBe("SIGTERM");
  await closed;
});

test.skipIf(!OWN_GROUP)("stopGroup escalates to SIGKILL for a grandchild that ignores SIGTERM", async () => {
  const { child, exited, closed, started } = shellWithGrandchild("trap '' TERM; exec sleep 60");
  await started;
  stopGroup(child, 50);
  expect((await exited)[1]).toBe("SIGTERM");
  await closed;
});
