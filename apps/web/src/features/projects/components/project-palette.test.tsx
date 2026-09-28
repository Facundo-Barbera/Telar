// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { Dialog, DialogContent } from "@/ui/dialog";
import { buttonLabelled, click, flush, installTestDom, mount, stubFetch, type Route } from "@/test/dom";
import { PROJECTS_CHANGED_EVENT } from "../projects";
import { clearField, typeInto } from "@/test/type-into";
import {
  cloneRequest,
  folderName,
  matchTargets,
  paletteBack,
  pathRequest,
  PROJECT_SOURCES,
  QUICK_PICK_LIMIT,
  sourceRows,
  targetPlace,
  type NewConversationTarget,
  type PalettePage,
} from "../palette-model";
import { ProjectPalette, ProjectPalettePages } from "./project-palette";

installTestDom();
afterEach(() => window.localStorage.clear());

const targets: NewConversationTarget[] = [
  { id: "project_a", name: "Telar", root: "/Users/someone/code/telar" },
  { id: "project_b", name: "Notes", root: "/Users/someone/code/notes" },
  { id: "project_c", name: "Telar", hostId: "host_mini", hostName: "mini" },
];

const listing = (path: string) => ({ path, name: folderName(path), parent: "/", home: "/Users/me", dirs: [] });

function engine(routes: Record<string, Route>, unreachable: string[] = []) {
  const calls = stubFetch(routes);
  const urls: string[] = [];
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (unreachable.some((path) => String(input).startsWith(path))) throw new TypeError("fetch failed");
    return stubbed(input, init);
  }) as typeof fetch;
  return { calls, urls };
}

async function openPalette(props: { page?: PalettePage; targets?: NewConversationTarget[] } = {}) {
  const log: string[] = [];
  const chosen: NewConversationTarget[] = [];
  await mount(
    <ProjectPalette
      open
      {...(props.page ? { page: props.page } : {})}
      targets={props.targets ?? targets}
      onOpenChange={(next) => log.push(`open:${next}`)}
      onChoose={(target) => (log.push(`choose:${target.id}`), chosen.push(target))}
      onRegistered={() => log.push("registered")}
    />,
  );
  await flush();
  return { log, chosen };
}

const field = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll('[role="option"]')];
const selected = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "";
const page = () => document.body.textContent ?? "";

async function key(init: KeyboardEventInit, target: Element = field()) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

test("a blank query is every project, not none", () => {
  expect(matchTargets(targets, "").length).toBe(3);
  expect(matchTargets(targets, "   ").length).toBe(3);
});

test("the row's sub-line names the machine and then the path, in that order", () => {
  expect(targetPlace(targets[0])).toBe("Local · /Users/someone/code/telar");
  expect(targetPlace(targets[2])).toBe("mini");
  expect(targetPlace({ id: "x", name: "x", hostName: "mini", root: "/code/x" })).toBe("mini · /code/x");
  expect(targetPlace({ id: "x", name: "x" })).toBe("Local");
});

test("anything the row shows is something you can type", () => {
  expect(matchTargets(targets, "notes").map((t) => t.id)).toEqual(["project_b"]);
  expect(matchTargets(targets, "mini").map((t) => t.id)).toEqual(["project_c"]);
  expect(matchTargets(targets, "code/notes").map((t) => t.id)).toEqual(["project_b"]);
  expect(matchTargets(targets, "local").map((t) => t.id)).toEqual(["project_a", "project_b"]);
  expect(matchTargets(targets, "TELAR").length).toBe(2);
  expect(matchTargets(targets, "nothing like this")).toEqual([]);
});

test("every project row is name · place · ⌘digit, and a paired Mac's same-named project is its own row", async () => {
  await openPalette();
  const rows = options();
  expect(rows.map((row) => row.textContent)).toEqual([
    "TTelarLocal · /Users/someone/code/telar⌘1",
    "NNotesLocal · /Users/someone/code/notes⌘2",
    "TTelarmini⌘3",
    "Add a project…A folder on this Mac, or a repository to clone",
  ]);
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Projects");
});

test("⌘1..⌘9 take the first nine rows AS FILTERED", async () => {
  expect(QUICK_PICK_LIMIT).toBe(9);
  const { chosen } = await openPalette();
  await typeInto(field(), "notes");
  expect(options()[0]?.textContent).toContain("⌘1");
  await key({ key: "1", metaKey: true });
  expect(chosen.map((target) => target.id)).toEqual(["project_b"]);
});

test("the arrows wrap, the highlight is announced, and Enter closes before it chooses", async () => {
  const { log } = await openPalette();
  expect(selected()).toContain("Telar");
  await key({ key: "ArrowUp" });
  expect(selected()).toContain("Add a project…");
  await key({ key: "ArrowDown" });
  await key({ key: "ArrowDown" });
  expect(selected()).toContain("Notes");
  expect(field().getAttribute("aria-activedescendant")).toBe("project-palette-projects-1");
  await key({ key: "Enter" });
  expect(log).toEqual(["open:false", "choose:project_b"]);
});

test("the mouse and the arrows never disagree about what Enter would take", async () => {
  const { chosen } = await openPalette();
  await act(async () => {
    options()[2]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  expect(selected()).toBe("TTelarmini⌘3");
  await key({ key: "Enter" });
  expect(chosen.map((target) => target.hostId)).toEqual(["host_mini"]);
});

test("an IME's Enter commits a candidate rather than choosing a project", async () => {
  const { chosen } = await openPalette();
  await act(async () => {
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await key({ key: "Enter" });
  expect(chosen).toEqual([]);
  await act(async () => {
    field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await key({ key: "Enter" });
  expect(chosen.map((target) => target.id)).toEqual(["project_a"]);
});

test("the empty state tells an empty registry apart from an empty search", async () => {
  await openPalette({ targets: [] });
  expect(page()).toContain("No projects registered yet.");
});

test("a search that matches nothing says so", async () => {
  await openPalette();
  await typeInto(field(), "nothing like this");
  expect(page()).toContain("No project matches that.");
});

test("reopening starts from a blank query on the asked-for page", async () => {
  let setOpen: (open: boolean) => void = () => {};
  function Reopenable() {
    const [open, set] = useState(true);
    setOpen = set;
    return <ProjectPalette open={open} page="sources" targets={targets} onOpenChange={set} onChoose={() => {}} onRegistered={() => {}} />;
  }
  await mount(<Reopenable />);
  await click(document.querySelector('[aria-label="Back to projects"]')!);
  await typeInto(field(), "notes");
  await act(async () => setOpen(false));
  await act(async () => setOpen(true));
  await flush();
  expect(field().value).toBe("");
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Sources");
});

test("the Projects page's last row walks to Sources, which always has a way back", async () => {
  await openPalette();
  expect(buttonLabelled("Back to projects")).toBeUndefined();
  expect(page()).not.toContain("Backspace Back");
  await key({ key: "ArrowUp" });
  await key({ key: "Enter" });
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Sources");
  expect(document.querySelector("h2")?.textContent).toBe("Add a project");
  expect(page()).toContain("Backspace Back");
  await click(document.querySelector('[aria-label="Back to projects"]')!);
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Projects");
  expect(document.querySelector("h2")?.textContent).toBe("New conversation");
});

test("Backspace goes back only on an empty field", async () => {
  await openPalette({ page: "sources" });
  await typeInto(field(), "g");
  await key({ key: "Backspace" });
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Sources");
  await clearField(field());
  await key({ key: "Backspace" });
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Projects");
});

test("an embedded Projects page backs out to whatever holds it", async () => {
  let backed = 0;
  await mount(
    <Dialog open>
      <DialogContent>
        <ProjectPalettePages page="projects" targets={targets} onClose={() => {}} onChoose={() => {}} onRegistered={() => {}} onBack={() => (backed += 1)} />
      </DialogContent>
    </Dialog>,
  );
  await flush();
  expect(page()).toContain("Backspace Back");
  await key({ key: "Backspace" });
  expect(backed).toBe(1);
  await click(document.querySelector('[aria-label="Back"]')!);
  expect(backed).toBe(2);
});

test("Sources lists six rows, three of them chipped and inert", async () => {
  expect(PROJECT_SOURCES.map((row) => row.title)).toEqual([
    "Local folder",
    "Git URL",
    "GitHub repository",
    "Azure DevOps",
    "Bitbucket",
    "Forgejo / Gitea",
  ]);
  await openPalette({ page: "sources" });
  const chipped = options().filter((row) => row.textContent?.includes("Setup Required"));
  expect(chipped.map((row) => row.id)).toEqual(["project-palette-sources-3", "project-palette-sources-4", "project-palette-sources-5"]);
  await click(options()[4]);
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Bitbucket is not set up yet. Clone it yourself and add it as a local folder.",
  );
  expect(options()).toHaveLength(6);
});

test("every Sources row is a title and a one-line sub-line", () => {
  for (const row of PROJECT_SOURCES) {
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.hint.length).toBeGreaterThan(0);
    expect(row.hint).not.toContain("\n");
  }
});

test("the Sources field filters on anything the rows say", () => {
  expect(sourceRows("").length).toBe(PROJECT_SOURCES.length);
  expect(sourceRows("folder").map((row) => row.id)).toEqual(["local"]);
  expect(sourceRows("self-hosted").map((row) => row.id)).toEqual(["forgejo"]);
  expect(sourceRows("nothing like this")).toEqual([]);
});

test("pasting a repository URL collapses the page to the one row that would act on it", () => {
  const github = sourceRows("https://github.com/owner/repo.git");
  expect(github.map((row) => row.id)).toEqual(["github"]);
  expect(github[0].hint).toBe("Clone https://github.com/owner/repo.git");
  expect(sourceRows("git@gitlab.com:owner/repo.git").map((row) => row.id)).toEqual(["git-url"]);
  expect(sourceRows("ssh://git@example.com/owner/repo.git").map((row) => row.id)).toEqual(["git-url"]);
  expect(sourceRows("NovarixHQ/Telar").map((row) => row.id)).toEqual(["github"]);
  expect(sourceRows("NovarixHQ/Telar")[0].hint).toBe("Clone NovarixHQ/Telar");
});

test("ordinary words are not mistaken for URLs", () => {
  expect(cloneRequest("github")).toBeUndefined();
  expect(cloneRequest("local folder")).toBeUndefined();
  expect(cloneRequest("")).toBeUndefined();
  expect(cloneRequest("/Users/someone/code/telar")).toBeUndefined();
});

test("a pasted folder path collapses the page to Local folder instead of matching nothing", () => {
  const drive = "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/[01] Work/repo";
  for (const pasted of [drive, "~/code/telar", "~", `file://${encodeURI(drive)}`]) {
    expect(sourceRows(pasted).map((row) => row.id)).toEqual(["local"]);
  }
  expect(sourceRows(drive)[0].hint).toBe(`Open ${drive}`);
  expect(cloneRequest(drive)).toBeUndefined();
});

test("a path arrives in the shapes people copy it in", () => {
  const drive = "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/[01] Work/repo";
  expect(pathRequest(`'${drive}'`)).toBe(drive);
  expect(pathRequest(`"${drive}"`)).toBe(drive);
  expect(pathRequest(`${drive}\n`)).toBe(drive);
  expect(pathRequest(`  "${drive}"\r\n`)).toBe(drive);
  expect(pathRequest("'~/code/telar'")).toBe("~/code/telar");
  expect(pathRequest("file:///Users/me/My%20Drive/%5B01%5D%20Work/repo")).toBe("/Users/me/My Drive/[01] Work/repo");
  expect(pathRequest("file://localhost/Users/me/code")).toBe("/Users/me/code");
  expect(pathRequest(`file://${encodeURI(drive)}\n`)).toBe(drive);
});

test("only a path is a path", () => {
  expect(pathRequest("")).toBeUndefined();
  expect(pathRequest("folder")).toBeUndefined();
  expect(pathRequest("owner/repo")).toBeUndefined();
  expect(pathRequest("https://github.com/owner/repo")).toBeUndefined();
  expect(pathRequest("~root/x")).toBeUndefined();
  expect(pathRequest("file://server/share/repo")).toBeUndefined();
  expect(pathRequest("'/Users/me/code\"")).toBeUndefined();
});

const registerRoutes = (gitignore: Route = () => ({ gitignore: {} })) => ({
  "GET /api/fs": () => listing("/Users/me/code/telar"),
  "POST /api/projects": (body: unknown) => ({ project: { id: "project_new", name: (body as { name: string }).name } }),
  "POST /api/projects/clone": () => ({ project: { id: "project_new", name: "repo" } }),
  "POST /api/projects/project_new/gitignore": gitignore,
  "DELETE /api/projects/project_new/gitignore": () => ({ gitignore: { removed: [] } }),
});

test("Local folder with a pasted path opens the browser at it, and Add registers it with Telar's files ignored", async () => {
  const { calls, urls } = engine(registerRoutes());
  let announced = 0;
  const count = () => (announced += 1);
  window.addEventListener(PROJECTS_CHANGED_EVENT, count);
  const { log } = await openPalette({ page: "sources" });
  await typeInto(field(), "'/Users/me/code/telar'");
  expect(options().map((row) => row.textContent)).toEqual(["Local folderOpen /Users/me/code/telar"]);
  await key({ key: "Enter" });
  await flush(() => Boolean(buttonLabelled("Add⌘↵")));
  expect(document.querySelector("h2")?.textContent).toBe("Choose a project folder");
  expect(urls).toContain("GET /api/fs?path=%2FUsers%2Fme%2Fcode%2Ftelar&nearest=1");

  await click(buttonLabelled("Add⌘↵"));
  await flush(() => log.includes("registered"));
  expect(calls.map((call) => call.route)).toEqual([
    "GET /api/fs",
    "POST /api/projects",
    "POST /api/projects/project_new/gitignore",
  ]);
  expect(calls[1]!.body).toEqual({ name: "telar", root: "/Users/me/code/telar" });
  expect(log).toEqual(["open:false", "registered"]);
  window.removeEventListener(PROJECTS_CHANGED_EVENT, count);
  expect(announced).toBe(1);
  expect(page()).toContain("telar was added.");
  expect(page()).toContain("Telar's files are ignored in its .gitignore.");

  await click(buttonLabelled("Undo"));
  await flush(() => page().includes("taken back out"));
  expect(calls.at(-1)!.route).toBe("DELETE /api/projects/project_new/gitignore");
  expect(buttonLabelled("Undo")).toBeUndefined();
  expect(log.at(-1)).toBe("registered");
});

test("a gitignore that cannot be written leaves the project registered and says so", async () => {
  engine(
    registerRoutes(() => {
      throw new Error("read-only");
    }),
  );
  const { log } = await openPalette({ page: "sources" });
  await key({ key: "Enter" });
  await flush(() => Boolean(buttonLabelled("Add⌘↵")));
  await click(buttonLabelled("Add⌘↵"));
  await flush(() => log.includes("registered"));
  expect(page()).toContain("Telar's files could not be added to its .gitignore.");
  expect(buttonLabelled("Undo")).toBeUndefined();
});

test("a clone row with nothing to clone asks for the URL, refuses junk, then asks where to put it", async () => {
  const { calls } = engine(registerRoutes());
  const { log } = await openPalette({ page: "sources" });
  await click(options()[1]);
  expect(page()).toContain("Enter a Git clone URL and press Enter to continue");
  const url = document.querySelector<HTMLInputElement>('[aria-label="Git clone URL"]')!;

  await typeInto(url, "not a url");
  await key({ key: "Enter" }, url);
  expect(page()).toContain("That is not a clone URL.");

  await clearField(url);
  await typeInto(url, "owner/repo");
  await key({ key: "Enter" }, url);
  await flush(() => Boolean(buttonLabelled("Clone here⌘↵")));
  expect(document.querySelector("h2")?.textContent).toBe("Choose where to clone");

  await click(buttonLabelled("Clone here⌘↵"));
  await flush(() => log.includes("registered"));
  expect(calls.find((call) => call.route === "POST /api/projects/clone")?.body).toEqual({
    url: "owner/repo",
    parent: "/Users/me/code/telar",
  });
});

test("a URL already in the search field skips the URL page", async () => {
  const { calls } = engine(registerRoutes());
  const { log } = await openPalette({ page: "sources" });
  await typeInto(field(), "https://github.com/owner/repo.git");
  await key({ key: "Enter" });
  await flush(() => Boolean(buttonLabelled("Clone here⌘↵")));
  await click(buttonLabelled("Clone here⌘↵"));
  await flush(() => log.includes("registered"));
  expect(calls.find((call) => call.route === "POST /api/projects/clone")?.body).toEqual({
    url: "https://github.com/owner/repo.git",
    parent: "/Users/me/code/telar",
  });
});

test("an unreachable engine offers the system picker, and what it picks is registered", async () => {
  const { calls } = engine({ ...registerRoutes(), "POST /api/browse": () => ({ path: "/Users/me/picked/" }) }, ["/api/fs"]);
  const { log } = await openPalette({ page: "sources" });
  await key({ key: "Enter" });
  const fallback = () => buttonLabelled("Choose a folder with the system picker instead");
  await flush(() => Boolean(fallback()));
  await click(fallback());
  await flush(() => log.includes("registered"));
  expect(calls.find((call) => call.route === "POST /api/projects")?.body).toEqual({ name: "picked", root: "/Users/me/picked" });
});

test("the folder name is what the project is called when nobody typed one", () => {
  expect(folderName("/Users/someone/code/telar")).toBe("telar");
  expect(folderName("/Users/someone/code/telar/")).toBe("telar");
  expect(folderName("C:\\code\\telar")).toBe("telar");
});

describe("where Backspace goes", () => {
  test("nowhere at all while there is something to delete", () => {
    expect(paletteBack("sources", "gith", "projects")).toBeUndefined();
    expect(paletteBack("projects", "x", "projects")).toBeUndefined();
  });

  test("Sources walks to Projects before it leaves the pages", () => {
    expect(paletteBack("sources", "", "projects")).toBe("projects");
  });

  test("a page that was itself the door leaves the pages", () => {
    expect(paletteBack("sources", "", "sources")).toBe("root");
    expect(paletteBack("projects", "", "projects")).toBe("root");
  });

  test("the standalone palette's Sources always has a back, because its root is Projects", () => {
    expect(paletteBack("sources", "", "projects")).toBe("projects");
  });
});
