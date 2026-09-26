/**
 * A TURN THE ENGINE WROTE AFTER A PLANNED RESTART is drawn as what it is — a
 * marker line — and never as a message bubble in the person's name. Pinned
 * against source, the way projects-page.test.tsx pins what only renders after a
 * live session exists.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./session-cockpit.tsx", import.meta.url), "utf8");

test("the continuation is not the person's bubble, and says it continued after the update", () => {
  expect(source).toContain('turn.origin !== "session" && turn.origin !== "restart" && (');
  expect(source).toContain("{turn.restartOrigin !== undefined && <Marker>continued after Telar restarted to update</Marker>}");
  // In the answer lane's own condition, or the marker would render invisibly.
  expect(source).toContain("turn.restartOrigin !== undefined ||");
});
