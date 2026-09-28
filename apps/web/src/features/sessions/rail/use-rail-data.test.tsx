import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useRailData } = await import("./use-rail-data");
const { announceProjectsChanged } = await import("@/features/projects/projects");

const realFetch = globalThis.fetch;
let root: Root | undefined;

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function Rail() {
  const { projects } = useRailData();
  return <p>{projects.map((project) => project.name).join(",") || "No projects yet"}</p>;
}

async function flush() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("a project added while the rail is mid-read still shows up", async () => {
  const registered: { id: string; name: string }[] = [];
  let firstRead: (() => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/hosts")) return Response.json({ hosts: [] });
    if (url.includes("/api/sessions/live")) {
      const page = Response.json({ projects: [...registered], sessions: [] });
      if (firstRead === undefined) return new Promise<Response>((resolve) => (firstRead = () => resolve(page)));
      return page;
    }
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Rail />));
  await flush();
  expect(firstRead).toBeDefined();

  registered.push({ id: "project_700d", name: "exoplanets" });
  act(() => announceProjectsChanged());
  firstRead!();
  await flush();

  expect(host.textContent).toBe("exoplanets");
});
