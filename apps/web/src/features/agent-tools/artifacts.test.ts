import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { artifactDocument, clampFrameHeight, contentHeight, latestArtifacts, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT, type LookTokens } from "./artifacts";

const look: LookTokens = { scheme: "dark", background: "#111", foreground: "#eee", muted: "#999", line: "#333", accent: "#36f" };

test("the policy leads the document, ahead of an agent's own doctype and markup", () => {
  const doc = artifactDocument("<!DOCTYPE html><html><head><meta http-equiv='Content-Security-Policy' content='default-src *'></head></html>", "f1", look);
  expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true);
  expect(doc.match(/<!doctype/gi)).toHaveLength(1);
});

test("a frame id cannot close the reporting script", () => {
  expect(artifactDocument("<svg/>", "</script><script>alert(1)</script>", look)).not.toContain("</script><script>alert(1)");
});

test("a Look token cannot break out of the injected style", () => {
  expect(artifactDocument("<p>x</p>", "f1", { ...look, accent: "red}</style><script>alert(1)</script>" })).not.toContain("</style><script>alert(1)");
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

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function frameWithContentEndingAt(bottom: number) {
  GlobalRegistrator.register({ url: "http://localhost/" });
  document.body.innerHTML = '<div class="kpis">18</div><div style="margin-bottom: 8px">last row</div><script style="margin-bottom: 99px"></script>';
  document.body.style.padding = "20px";
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 600, bottom);
  return document;
}

test("the measured height is where the content ends, plus the body's own padding and the last margin", () => {
  expect(contentHeight(frameWithContentEndingAt(300))).toBe(328);
});

test("re-measuring after the frame grows gives the same height, even for a body that fills the viewport", () => {
  const doc = frameWithContentEndingAt(300);
  const first = contentHeight(doc);
  doc.body.style.minHeight = "100vh";
  doc.body.style.height = `${first + 400}px`;
  expect(contentHeight(doc)).toBe(first);
});
