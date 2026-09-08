/**
 * The interleavings a `busy` flag gets wrong.
 *
 * Every test here is a response arriving at a moment the naive version would
 * have honoured it: after a second submission, after the subject changed under
 * the same mounted component, out of order.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { createRequestGate } from "./request-gate";

test("a second submission while one is in flight is refused", () => {
  const gate = createRequestGate();
  const first = gate.begin("project_a");
  expect(first).toBe(1);
  expect(gate.begin("project_a")).toBeUndefined();
  expect(gate.inFlight()).toBe(true);
  expect(gate.settle(first!)).toBe(true);
  // Released, so the next one may go.
  expect(gate.inFlight()).toBe(false);
  expect(gate.begin("project_a")).toBe(2);
});

test("an answer that arrives twice is honoured once", () => {
  const gate = createRequestGate();
  const token = gate.begin("project_a")!;
  expect(gate.settle(token)).toBe(true);
  expect(gate.settle(token)).toBe(false);
});

test("the subject changing under the same component disowns what is in flight", () => {
  // THE CASE THE UNMOUNT GUARD MISSES: same mounted component, new project in
  // its props. Without this the first answer calls back with the OLD record
  // and navigates away from the new one.
  const gate = createRequestGate();
  const stale = gate.begin("project_a")!;
  gate.retarget("project_b");
  expect(gate.settle(stale)).toBe(false);
  // …and the gate is open for the new subject rather than stuck.
  const fresh = gate.begin("project_b")!;
  expect(gate.settle(fresh)).toBe(true);
});

test("a re-render with the SAME subject changes nothing", () => {
  // `retarget` runs on every identity-effect pass, including the ones where
  // nothing moved; it must not cancel the request it is watching over.
  const gate = createRequestGate();
  const token = gate.begin("project_a")!;
  gate.retarget("project_a");
  gate.retarget("project_a");
  expect(gate.settle(token)).toBe(true);
});

test("a slow first answer cannot overwrite a fast second one", () => {
  // Remove on A (slow), navigate to B, remove on B (fast). B's answer lands
  // first and owns the screen; A's must be dropped when it finally arrives.
  const gate = createRequestGate();
  const slowA = gate.begin("project_a")!;
  gate.retarget("project_b");
  const fastB = gate.begin("project_b")!;
  expect(gate.settle(fastB)).toBe(true);
  expect(gate.settle(slowA)).toBe(false);
});

test("a failure releases the gate the same way a success does", () => {
  const gate = createRequestGate();
  const failed = gate.begin("project_a")!;
  expect(gate.settle(failed)).toBe(true);
  expect(gate.begin("project_a")).toBe(2);
});
