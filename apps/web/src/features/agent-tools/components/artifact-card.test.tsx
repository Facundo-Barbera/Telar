import { describe, expect, test } from "bun:test";
import type { Artifact, ArtifactKind, Item } from "@telar/engine-client";
import { buttonLabelled, click, flush, installTestDom, mount } from "@/test/dom";
import { RightPanel } from "@/features/panel";
import { ArtifactCard, ArtifactShelf } from "./artifact-card";

installTestDom();

const SOURCES: Record<string, string> = {
  att_html: "<h1>Revenue</h1><script>document.title='x'</script>",
  att_svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle id="agent-dot" r="4"/></svg>',
  att_md: "# Plan\n\n- ship it",
  att_mermaid: "graph TD; A-->B",
};

function serveAttachments() {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    const source = SOURCES[path.split("/").at(-1)!];
    return source === undefined ? new Response("missing", { status: 404 }) : new Response(source, { headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  return asked;
}

const artifact = (kind: ArtifactKind, attachmentId: string, version = 1): Artifact => ({ id: "art_1", kind, title: `A ${kind}`, attachmentId, version });
const item = (value: Artifact): Pick<Item, "detail"> => ({ detail: { type: "artifact", artifact: value } });

async function card(value: Artifact, shelf: { items?: Pick<Item, "detail">[]; onOpen?: (id: string) => void } = {}) {
  const { host } = await mount(
    <ArtifactShelf items={shelf.items ?? [item(value)]} {...(shelf.onOpen ? { onOpen: shelf.onOpen } : {})}>
      <ArtifactCard sessionId="session_1" artifact={value} />
    </ArtifactShelf>,
  );
  return host;
}

describe("an artifact card", () => {
  test("html runs in a frame that may script but never shares the cockpit's origin or network", async () => {
    const asked = serveAttachments();
    const host = await card(artifact("html", "att_html"));
    await flush(() => host.querySelector("iframe") !== null);
    const frame = host.querySelector("iframe")!;
    expect(asked).toEqual(["/api/sessions/session_1/attachments/att_html"]);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc).toContain("default-src 'none'");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>Revenue</h1>"));
  });

  test("svg is drawn in the same sandbox, never into the page", async () => {
    serveAttachments();
    const host = await card(artifact("svg", "att_svg"));
    await flush(() => host.querySelector("iframe") !== null);
    expect(host.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(host.querySelector("#agent-dot")).toBeNull();
  });

  test("markdown renders as the transcript renders it", async () => {
    serveAttachments();
    const host = await card(artifact("markdown", "att_md"));
    await flush(() => host.querySelector("h1") !== null);
    expect(host.querySelector("h1")?.textContent).toBe("Plan");
    expect(host.textContent).toContain("ship it");
  });

  test("mermaid is handed to the markdown renderer as a diagram, not shown as prose", async () => {
    serveAttachments();
    const host = await card(artifact("mermaid", "att_mermaid"));
    await flush(() => host.querySelector("[data-streamdown='mermaid-block'], [data-streamdown*='mermaid']") !== null);
    expect(host.querySelector("[data-streamdown*='mermaid']")).not.toBeNull();
  });

  test("an earlier version folds to its header and names the newest", async () => {
    serveAttachments();
    const first = artifact("markdown", "att_md", 1);
    const host = await card(first, { items: [item(first), item(artifact("markdown", "att_md", 2))] });
    await flush();
    expect(host.textContent).toContain("v1 · now v2");
    expect(host.querySelector("h1")).toBeNull();
  });

  test("Open in panel asks for this artifact", async () => {
    serveAttachments();
    const opened: string[] = [];
    const host = await card(artifact("markdown", "att_md"), { onOpen: (id) => opened.push(id) });
    await click(buttonLabelled("Open in panel", host));
    expect(opened).toEqual(["art_1"]);
  });
});

test("the panel draws an artifact tab from the newest version in the conversation", async () => {
  serveAttachments();
  const items = [artifact("html", "att_html", 1), artifact("markdown", "att_md", 2)].map(
    (value, index) => ({ id: `artifact_art_1_v${index + 1}`, runId: "run_1", sessionId: "session_1", status: "completed", startedAt: 1, ...item(value) }) as Item,
  );
  const { host } = await mount(
    <RightPanel sessionId="session_1" items={items} tabs={[{ id: "t1", kind: "artifact:art_1", params: {} }]} tab="t1" onTabChange={() => {}} onOpenTab={() => {}} onCloseTab={() => {}} onClose={() => {}} />,
  );
  await flush(() => host.querySelector("h1") !== null);
  expect(host.querySelector("h1")?.textContent).toBe("Plan");
});
