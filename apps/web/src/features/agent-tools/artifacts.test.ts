import { expect, test } from "bun:test";
import { artifactDocument, clampFrameHeight, latestArtifacts, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT } from "./artifacts";

test("the policy leads the document, ahead of an agent's own doctype and markup", () => {
  const doc = artifactDocument("html", "<!DOCTYPE html><html><head><meta http-equiv='Content-Security-Policy' content='default-src *'></head></html>", "f1");
  expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true);
  expect(doc.match(/<!doctype/gi)).toHaveLength(1);
});

test("a frame id cannot close the reporting script", () => {
  expect(artifactDocument("svg", "<svg/>", "</script><script>alert(1)</script>")).not.toContain("</script><script>alert(1)");
});

test("a reported height is clamped, and anything that is not a number is ignored", () => {
  expect(clampFrameHeight(10)).toBe(MIN_FRAME_HEIGHT);
  expect(clampFrameHeight(99_999)).toBe(MAX_FRAME_HEIGHT);
  expect(clampFrameHeight(300.2)).toBe(301);
  expect(clampFrameHeight("300")).toBeUndefined();
  expect(clampFrameHeight(Number.NaN)).toBeUndefined();
});

test("the newest version of each artifact wins, in any order", () => {
  const item = (id: string, version: number) => ({ detail: { type: "artifact" as const, artifact: { id, kind: "svg" as const, title: "t", attachmentId: `att_${id}${version}`, version } } });
  const latest = latestArtifacts([item("a", 2), item("a", 1), item("b", 1), { detail: { type: "assistant_message" as const, text: "" } }]);
  expect([...latest].map(([id, artifact]) => `${id}:${artifact.version}`)).toEqual(["a:2", "b:1"]);
});
