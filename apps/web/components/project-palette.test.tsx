// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  cloneRequest,
  folderName,
  matchTargets,
  PROJECT_SOURCES,
  QUICK_PICK_LIMIT,
  sourceRows,
  targetPlace,
  type NewConversationTarget,
} from "./project-palette";

/**
 * THE PALETTE'S RULES, and the two halves they live in.
 *
 * `matchTargets`, `sourceRows` and `cloneRequest` are the whole of what typing
 * does, so they are exercised directly rather than through a render — the same
 * shape `lib/`-side logic gets everywhere else here. The KEYBOARD cannot be
 * driven by a static render (and the dialog renders through a portal, so there
 * is no markup to assert on either), so the parts that only exist after a
 * keystroke are pinned against source, exactly as settings-search-nav.test.tsx
 * pins its own.
 */
const source = readFileSync(new URL("./project-palette.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./app-sidebar.tsx", import.meta.url), "utf8");

const targets: NewConversationTarget[] = [
  { id: "project_a", name: "Telar", root: "/Users/someone/code/telar" },
  { id: "project_b", name: "Notes", root: "/Users/someone/code/notes" },
  { id: "project_c", name: "Telar", hostId: "host_mini", hostName: "mini" },
];

test("a blank query is every project, not none", () => {
  expect(matchTargets(targets, "").length).toBe(3);
  expect(matchTargets(targets, "   ").length).toBe(3);
});

test("the row's sub-line names the machine and then the path, in that order", () => {
  // The kind is SAID rather than implied by the absence of a chip two columns
  // away from the path it qualified.
  expect(targetPlace(targets[0])).toBe("Local · /Users/someone/code/telar");
  // A paired Mac's project has no root in the rail's aggregate read, so the line
  // is just the Mac — inventing "somewhere on mini" would be words for a fact.
  expect(targetPlace(targets[2])).toBe("mini");
  expect(targetPlace({ id: "x", name: "x", hostName: "mini", root: "/code/x" })).toBe("mini · /code/x");
  expect(targetPlace({ id: "x", name: "x" })).toBe("Local");
});

test("anything the row shows is something you can type", () => {
  // The row shows the name and that line — so both match, which is the rule that
  // keeps a reader from typing what they can see and getting nothing.
  expect(matchTargets(targets, "notes").map((t) => t.id)).toEqual(["project_b"]);
  expect(matchTargets(targets, "mini").map((t) => t.id)).toEqual(["project_c"]);
  expect(matchTargets(targets, "code/notes").map((t) => t.id)).toEqual(["project_b"]);
  // Including the word the row now says out loud.
  expect(matchTargets(targets, "local").map((t) => t.id)).toEqual(["project_a", "project_b"]);
  // Case is not a filter.
  expect(matchTargets(targets, "TELAR").length).toBe(2);
  expect(matchTargets(targets, "nothing like this")).toEqual([]);
});

test("a paired Mac's projects are in the same list, told apart by the host", () => {
  const both = matchTargets(targets, "telar");
  expect(both.map((t) => t.hostName)).toEqual([undefined, "mini"]);
  // Two Macs can register the same project id, so the row's key carries the
  // host — otherwise React reconciles them into one row.
  expect(source).toContain('key={`${target.hostId ?? "local"}:${target.id}`}');
});

test("every project row is icon · name · place · ⌘digit", () => {
  const row = source.slice(source.indexOf("{matches.map((target, row) => ("), source.indexOf("{/* THE DOOR TO THE OTHER PAGE"));
  // The project's real mark, with all four of `ProjectAvatar`'s honesties behind
  // it — a chosen glyph, the checkout's own icon, a tinted initial, a folder.
  expect(row).toContain("<ProjectAvatar");
  expect(row).toContain("title={target.name}");
  expect(row).toContain("hint={targetPlace(target)}");
  expect(row).toContain("key9: row + 1");
  // The monitor chip beside the name is gone; the machine is on the sub-line.
  expect(source).not.toContain("MonitorIcon");
});

test("the list is captioned, because the field says what you may type rather than what this is", () => {
  expect(source).toContain('{page === "sources" ? "Sources" : "Projects"}');
});

test("⌘1..⌘9 take the first nine rows AS FILTERED", () => {
  expect(QUICK_PICK_LIMIT).toBe(9);
  // The number is the row's place in front of the reader, not its place in an
  // unfiltered registry — so the key resolves through `take`, which indexes the
  // page's own drawn rows.
  expect(source).toContain("take(Number(event.key) - 1);");
  expect(source).toContain("row < QUICK_PICK_LIMIT ? { key9: row + 1 }");
});

test("the arrows wrap over whatever page is up, and Enter takes the highlighted row", () => {
  expect(source).toContain("(current + delta + count) % count");
  expect(source).toContain('if (event.key === "Enter") {');
  expect(source).toContain("take(index);");
  // One counter for both pages, so neither can drift out of the highlight's range.
  expect(source).toContain('const count = page === "projects" ? matches.length + 1 : rows.length;');
});

test("an IME's Enter commits a candidate rather than choosing a project", () => {
  expect(source).toContain("composing.current || event.nativeEvent.isComposing || event.keyCode === 229");
});

test("the highlight is announced, not just drawn", () => {
  expect(source).toContain('role="listbox"');
  expect(source).toContain('role="option"');
  expect(source).toContain("aria-selected={on}");
  expect(source).toContain("aria-activedescendant");
});

test("the mouse and the arrows never disagree about what Enter would take", () => {
  expect(source).toContain("onMouseMove={onHover}");
});

test("choosing closes before it navigates, and opening starts from a blank query on the asked-for page", () => {
  const choose = source.slice(source.indexOf("const choose ="));
  expect(choose.slice(0, 220)).toContain("onOpenChange(false)");
  const fresh = source.slice(source.indexOf("if (open !== wasOpen) {"));
  expect(fresh.slice(0, 260)).toContain("setPage(openOn);");
  expect(fresh.slice(0, 260)).toContain('setQuery("");');
});

test("focus is the browser's — never a focus() call, which kills the WebKit build", () => {
  expect(source).toContain("autoFocus");
  // The prose above the component names `.focus()` to explain the ban, so the
  // check is for a real call — a ref or an element reached and focused.
  expect(/\b(current|ref|input|element)\??\.focus\(\)/.test(source)).toBe(false);
});

test("the empty state tells an empty registry apart from an empty search", () => {
  expect(source).toContain("No projects registered yet.");
  expect(source).toContain("No project matches that.");
});

/* ─── the second page ─────────────────────────────────────────────────────── */

test("Sources lists six rows, three of them chipped and inert", () => {
  expect(PROJECT_SOURCES.map((row) => row.title)).toEqual([
    "Local folder",
    "Git URL",
    "GitHub repository",
    "Azure DevOps",
    "Bitbucket",
    "Forgejo / Gitea",
  ]);
  // Listed rather than hidden: somebody looking for Bitbucket learns Telar knows
  // the word and has not wired it up, instead of concluding it does not exist.
  expect(PROJECT_SOURCES.filter((row) => row.setupRequired).map((row) => row.id)).toEqual(["azure", "bitbucket", "forgejo"]);
  expect(source).toContain("Setup Required");
  // And pressing one says so rather than being a dead key.
  expect(source).toContain("is not set up yet.");
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
  // The sub-line is searchable too, so typing what you can read works.
  expect(sourceRows("self-hosted").map((row) => row.id)).toEqual(["forgejo"]);
  expect(sourceRows("nothing like this")).toEqual([]);
});

test("pasting a repository URL collapses the page to the one row that would act on it", () => {
  // The reader has already said what they want; offering five other sources to
  // arrow past is asking the question again.
  const github = sourceRows("https://github.com/owner/repo.git");
  expect(github.map((row) => row.id)).toEqual(["github"]);
  expect(github[0].hint).toBe("Clone https://github.com/owner/repo.git");

  expect(sourceRows("git@gitlab.com:owner/repo.git").map((row) => row.id)).toEqual(["git-url"]);
  expect(sourceRows("ssh://git@example.com/owner/repo.git").map((row) => row.id)).toEqual(["git-url"]);
  // `owner/repo` is GitHub's shorthand, and the ENGINE expands it — this side
  // only decides which row to draw.
  expect(sourceRows("Facundo-Barbera/Telar").map((row) => row.id)).toEqual(["github"]);
  expect(sourceRows("Facundo-Barbera/Telar")[0].hint).toBe("Clone Facundo-Barbera/Telar");
});

test("ordinary words are not mistaken for URLs", () => {
  expect(cloneRequest("github")).toBeUndefined();
  expect(cloneRequest("local folder")).toBeUndefined();
  expect(cloneRequest("")).toBeUndefined();
  // A path is not a URL: it would be a local folder, and that row has a picker.
  expect(cloneRequest("/Users/someone/code/telar")).toBeUndefined();
});

test("a clone row with nothing to clone opens the URL page instead of scolding the reader", () => {
  // It used to answer with a sentence telling you to go and type in the field
  // you had just left — a dead Enter key dressed up as guidance. Now the row
  // walks to a page with a field on it, which is T3's shape.
  expect(source).toContain('go(clone ? "clone-parent" : "clone-url");');
  expect(source).toContain("Enter a Git clone URL and press Enter to continue");
  // And a URL already in the search field skips that page, because the reader
  // has already answered the question.
  expect(source).toContain("const clone = cloneRequest(query);");
});

test("Backspace goes back ONLY on an empty field", () => {
  // The field is the title, so Backspace is a text key first — taking it while
  // somebody deletes a typo would throw their page away mid-word.
  expect(source).toContain('if (event.key === "Backspace" && page === "sources" && query === "") {');
  expect(source).toContain('go("projects");');
});

test("the legend names Backspace only on the page that has a back", () => {
  expect(source).toContain("↑↓</kbd> Navigate");
  expect(source).toContain("Enter</kbd> Select");
  expect(source).toContain("Esc</kbd> Close");
  const legend = source.slice(source.indexOf("Backspace</kbd> Back") - 200, source.indexOf("Backspace</kbd> Back"));
  expect(legend).toContain('page === "sources" &&');
});

test("the Sources page always has a back, and the Projects page has a door", () => {
  // Both entry points converge here, and Projects is a legitimate place to
  // arrive at from either.
  expect(source).toContain('aria-label="Back to projects"');
  expect(source).toContain('title="Add a project…"');
  // The door is a ROW, so the arrows reach it — `count` above already counts it.
  expect(source).toContain('if (at >= matches.length) go("sources");');
});

test("the folder name is what the project is called when nobody typed one", () => {
  expect(folderName("/Users/someone/code/telar")).toBe("telar");
  expect(folderName("/Users/someone/code/telar/")).toBe("telar");
  expect(folderName("C:\\code\\telar")).toBe("telar");
});

test("registering ignores Telar's files by default, and the toast carries the Undo", () => {
  // It was a switch in the old dialog, off by default, which asked everybody a
  // question about `.gitignore` on the way into their first project.
  expect(source).toContain("await api.projectGitignore(project.id);");
  expect(source).toContain("api\n      .undoProjectGitignore(toast.projectId)");
  // The gitignore is a SECOND request and its failure is not the project's: the
  // project stays registered and the toast says the rules did not land.
  expect(source).toContain("Telar's files could not be added to its .gitignore.");
  expect(source).toContain("announceProjectsChanged();");
});

test("the two ways in share one after-the-fact path", () => {
  // Otherwise the clone flow and the folder flow drift on what they announce,
  // what they ignore and what they report.
  expect(source).toContain("await settle((await api.registerProject(");
  expect(source).toContain("await settle((await api.cloneProject(");
  // And the clone still asks where to put it rather than inventing a code
  // folder — it is the browser page that asks now, not a Finder sheet.
  expect(source).toContain('actionLabel={page === "local" ? "Add" : "Clone here"}');
});

/* ─── the three pages that replaced the Finder sheet ──────────────────────── */

test("the source rows walk to a page instead of opening a native dialog", () => {
  // `dialog.showOpenDialog` leaves the palette, has none of its keyboard, and
  // from a browser tab or a paired Mac opens where nobody is looking.
  expect(source).toContain("<DirectoryBrowser");
  expect(source).toContain('go("local");');
  // Every page the palette can be ON, including the ones you can only walk to.
  expect(source).toContain('type Page = PalettePage | "local" | "clone-url" | "clone-parent";');
});

test("the exported page type still names only the two lists, for the command palette to reuse", () => {
  // `page` is a prop the rail and ⌘N pass; the browser and the URL field are
  // not destinations anything outside this file should be able to name.
  expect(source).toContain('export type PalettePage = "projects" | "sources";');
});

test("the palette's own keys stop at the list pages", () => {
  // Backspace goes UP in a folder browser. Left unguarded, the palette's rule
  // would have sent it back to Projects instead.
  expect(source).toContain('if (page !== "projects" && page !== "sources") return;');
});

test("every page is named for a screen reader, from a map rather than a five-deep ternary", () => {
  expect(source).toContain("const PAGE_TITLES: Record<Page, string> = {");
  expect(source).toContain("const PAGE_SENTENCES: Record<Page, string> = {");
  expect(source).toContain("aria-label={PAGE_TITLES[page]}");
});

test("the native picker survives as the fallback for an unreachable engine", () => {
  // The listing crosses HTTP; `chooseDirectory` goes through the shell's own
  // IPC and keeps working when the adapter does not.
  expect(source).toContain("const pickWithSystem = (title: string, then: (path: string) => void) => {");
  expect(source).toContain("onFallback={() =>");
  expect(source).toContain('"Choose a project folder for Telar"');
  expect(source).toContain('"Choose the folder to clone into"');
});

test("the clone URL outlives the page that asked for it", () => {
  // Two pages: one asks for the URL, the next picks the parent. A URL held on
  // the first would be gone by the time the clone runs.
  expect(source).toContain("const [cloneUrl, setCloneUrl] = useState<string>();");
  expect(source).toContain("api.cloneProject({ url: cloneUrl, parent })");
  // And a fresh opening does not carry the last one's URL.
  const fresh = source.slice(source.indexOf("if (open !== wasOpen) {"));
  expect(fresh.slice(0, 320)).toContain("setCloneUrl(undefined);");
});

test("the URL page refuses junk with a sentence rather than walking on", () => {
  expect(source).toContain("That is not a clone URL.");
  expect(source).toContain("const takeCloneUrl = (typed: string) => {");
});

/* ─── the rail ────────────────────────────────────────────────────────────── */

test("the rail has one New-conversation control, and ⌘N opens the same thing", () => {
  // It used to be two: a plain button, and — only with a Mac paired — a menu.
  // Both now go through `newConversation`, which is the single place that
  // decides between the palette and a canvas.
  expect(sidebar).toContain("onClick={newConversation}");
  expect(sidebar).toContain('"new-conversation": () => newConversation(),');
});

test("a registry of one skips the palette rather than asking a question with one answer", () => {
  // A search field over a list of one row, to be told what the cockpit already
  // knew. The palette earns itself once there are two places to go.
  expect(sidebar).toContain("const soleTarget = pickerTargets.length === 1 ? pickerTargets[0] : undefined;");
  const decide = sidebar.slice(sidebar.indexOf("const newConversation ="));
  expect(decide.slice(0, 280)).toContain("if (soleTarget) startSession(");
  expect(decide.slice(0, 280)).toContain('else openPalette("projects");');
});

test("the palette is offered every project the rail already reads, this Mac's first", () => {
  const list = sidebar.slice(sidebar.indexOf("const pickerTargets"));
  expect(list.indexOf("projects.map")).toBeLessThan(list.indexOf("remoteProjects.map"));
  // And a chosen row opens that project's canvas on ITS Mac, host and all.
  expect(sidebar).toContain("startSession({ projectId: target.id, ...(target.hostId ? { hostId: target.hostId } : {}) })");
});

test("the register dialog is gone, and every way in is the palette's Sources page", () => {
  // Two dialogs with two flags is how the rail ended up able to have a register
  // form open behind a project picker.
  expect(sidebar).not.toContain("RegisterProjectDialog");
  expect(sidebar).toContain('const openPalette = (page: PalettePage) => setPalette({ open: true, page });');
  expect(sidebar).toContain('onClick={() => openPalette("sources")}');
});
