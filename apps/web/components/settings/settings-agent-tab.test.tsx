/**
 * THE AGENT'S OWN TAB (#556) — that it is in the nav, that its rows left
 * General, and that a link to the old home still arrives.
 *
 * TWO HALVES, DELIBERATELY. The nav and the render arms are the ROUTE CONTRACT,
 * and `settings-nav.test.ts` beside this reads those from source for the reason
 * stated there: a pane id that stops answering strands a bookmark, and source is
 * where that is visible without standing up a page. The ALIAS is the half a
 * string match cannot honestly cover — "the table contains `main: agent`" is not
 * "a person following that link lands on the Agent" — so it runs the real hook
 * against the real table with a real URL.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SECTION_ALIASES, SECTION_IDS } from "./settings-page";
import { useSectionFromUrl } from "./use-section-from-url";

const source = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

test("Agent is a pane under Runtime, wearing the rail entry's glyph", () => {
  // The same `SparklesIcon` components/session/agent-entry.tsx draws, so the nav
  // item and the thing it configures are one subject rather than two.
  expect(source).toContain('{ id: "agent", label: "Agent", icon: SparklesIcon, group: "Runtime" }');
  expect(source).toContain('active === "agent" && <AgentSection />');
});

test("the Agent's rows are off General, and General keeps the rest", () => {
  const general = source.slice(source.indexOf('active === "general"'), source.indexOf('active === "agent"'));
  expect(general).not.toContain("<AgentSection");
  // The pane it left is otherwise untouched — the move must not take a
  // neighbour with it.
  expect(general).toContain("<WorkspaceSection");
  expect(general).toContain("<InboxSection");
  expect(general).toContain("<AboutSection");
});

/**
 * REGISTERED HERE AND UNREGISTERED IN `afterAll` — Happy DOM throws on a second
 * `register`, so a file that takes it without giving it back breaks whichever
 * file happens to run next.
 */
GlobalRegistrator.register({ url: "http://localhost/settings?section=main" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => void GlobalRegistrator.unregister());

/** A probe that renders nothing but the pane the hook resolved. */
function Probe() {
  const [active] = useSectionFromUrl("general", SECTION_IDS, SECTION_ALIASES);
  return <span>{active}</span>;
}

async function resolved(search: string): Promise<string> {
  window.history.replaceState(null, "", `/settings${search}`);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => void root.render(<Probe />));
  // The hook reads the URL in a deferred effect — see use-section-from-url.ts
  // for why it cannot seed from `window` during render.
  await act(async () => void (await new Promise((done) => setTimeout(done, 0))));
  const text = host.textContent ?? "";
  await act(async () => void root.unmount());
  host.remove();
  return text;
}

test("a link naming the Agent by its old word lands on the Agent's pane", async () => {
  // "Main" is what this feature was called before #531, and the registry still
  // carries it as a keyword because people who used it keep typing it.
  expect(await resolved("?section=main")).toBe("agent");
  expect(await resolved("?section=agent")).toBe("agent");
});

test("every id that pointed at General still lands on General", async () => {
  // The Agent moved; General did not. The retired ids that merged into it —
  // and the OAuth callback's own `section=mcp` — must be untouched by #556.
  for (const id of ["general", "sessions", "inbox", "textgen", "updates", "about", "application", "settled"]) {
    expect(await resolved(`?section=${id}`)).toBe("general");
  }
  expect(await resolved("?section=mcp")).toBe("tools");
});
