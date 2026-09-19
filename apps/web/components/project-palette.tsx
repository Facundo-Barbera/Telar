"use client";

/**
 * ONE PALETTE: where a conversation goes, and where a project comes from.
 *
 * TWO LISTS AND THREE PAGES BEHIND THEM. The lists are the palette proper —
 * Projects and Sources, both a field you type at. The three behind Sources are
 * what a source row now WALKS TO instead of doing: a folder browser, a clone
 * URL field, and the browser again for the clone's parent. They used to be
 * Electron's `dialog.showOpenDialog`, which leaves the palette you were
 * half-way through, has none of its keyboard, and — in a browser tab or on a
 * paired Mac — opens on a machine nobody is looking at. `chooseDirectory`
 * survives as the fallback for an engine the cockpit cannot reach, because the
 * listing crosses HTTP and the shell's own IPC does not.
 *
 * IT WAS `new-conversation-dialog.tsx`, and it grew a second page because the
 * OTHER half of "which project" had no palette at all — registering one was a
 * modal form with a path field, a Browse button, an optional name and a switch.
 * T3 Code makes both the same gesture (see `docs/design/t3code-survey/`), and the
 * argument is the one the first page already made here: a palette is a list you
 * can type at, and "add a project" is a list — a folder on this disk, a URL to
 * clone, a forge that is not wired up yet.
 *
 * WHY NOT TWO COMPONENTS. The pages share the field, the arrows, the ⌘-digits,
 * the highlight, the legend and the portal; two files would be that machinery
 * twice, kept in step by hand. What differs is the rows and what Enter does to
 * one — which is a `page`, not a component.
 *
 * BACKSPACE GOES BACK ONLY ON AN EMPTY FIELD. The field is the title, so
 * Backspace is a text key first: taking it while somebody is deleting a typo
 * would throw their page away mid-word. Empty field, nothing to delete, the key
 * is free — the same rule every palette that does this uses. And the rule stops
 * at the lists: in a folder browser Backspace goes UP, which is that page's own
 * decision to make (`lib/directory-browser.ts`).
 *
 * THE SOURCES PAGE ALWAYS HAS A BACK. Both doors lead here (the rail's add
 * button opens it directly; the Projects page's last row walks in), and Projects
 * is a legitimate place to arrive at from either.
 *
 * FOCUS IS THE BROWSER'S, NOT OURS. `autoFocus` is an attribute the browser
 * honours while the element is being inserted; a `.focus()` call after open is
 * what kills the WebKit build this app's browser surfaces run on, which is why
 * `DialogContent` sets `initialFocus={false}` (see ui/dialog.tsx).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BoxesIcon,
  CloudIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LinkIcon,
  SearchIcon,
  ServerIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { DirectoryBrowser } from "@/components/directory-browser";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { chooseDirectory } from "@/lib/choose-directory";
import { paletteBack, type PaletteSubPage } from "@/lib/command-palette";
import { claimChords } from "@/lib/commands";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { announceProjectsChanged } from "@/lib/projects";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** One destination: a project, and the Mac it is registered on when that Mac
 *  is not this one. `root` is absent for a paired Mac's project — the rail's
 *  aggregate read does not carry it — and the row simply omits the path. */
export type NewConversationTarget = {
  id: string;
  name: string;
  icon?: string;
  /** The glyph somebody picked, which outranks `icon` — see `ProjectAvatar`. */
  iconName?: string;
  hostId?: string;
  hostName?: string;
  root?: string;
};

/**
 * Which list the palette can be OPENED on. Deliberately the two LISTS and not
 * every page: `page` is a prop the rail and ⌘N pass, and the pages you can only
 * walk to from a row — the folder browser, the clone URL field — are not
 * destinations anything outside this file should be able to name.
 */
export type PalettePage = "projects" | "sources";

/**
 * Every page the palette can BE on.
 *
 * THE THREE NEW ONES REPLACE A NATIVE DIALOG. "Local folder" and the two clone
 * rows used to call Electron's folder picker (lib/choose-directory.ts), which
 * covers the palette you are half-way through and, in a browser tab or on a
 * paired Mac, opens on a machine nobody is looking at. T3 Code browses inside
 * the palette; `clone-url` is its own page for the same reason its Git URL page
 * is one — "paste a URL" is a different question from "pick a source", and
 * answering it in the search field meant the field was two things at once.
 */
type Page = PalettePage | "local" | "clone-url" | "clone-parent";

/**
 * WHAT THE DIALOG IS CALLED, per page — for the screen reader and the
 * `aria-label`, which are the only places the palette has a heading at all.
 *
 * A MAP RATHER THAN A NESTED TERNARY, because there are five pages now: the
 * two-page version read fine as `page === "sources" ? … : …` and a five-deep
 * chain of those is where one page quietly ends up labelled as another.
 */
const PAGE_TITLES: Record<Page, string> = {
  projects: "New conversation",
  sources: "Add a project",
  local: "Choose a project folder",
  "clone-url": "Clone a repository",
  "clone-parent": "Choose where to clone",
};

const PAGE_SENTENCES: Record<Page, string> = {
  projects: "Choose the project this conversation belongs to.",
  sources: "Choose where the project comes from.",
  local: "Browse for the folder that holds the project.",
  "clone-url": "Enter the repository to clone.",
  "clone-parent": "Browse for the folder to clone into.",
};

/** ⌘1..⌘9 reach the first nine ROWS AS FILTERED, which is what makes them
 *  useful with a query typed: the number is the row's place in front of you,
 *  not its place in an unfiltered registry. */
export const QUICK_PICK_LIMIT = 9;

/**
 * THE CHORDS THIS PALETTE OWNS WHILE A LIST PAGE IS UP — issue #656.
 *
 * IT USED TO OWN THEM ONLY IN THIS FILE'S IMAGINATION. The rows have drawn a
 * ⌘digit since they existed and `onKeyDown` below has always tested for one, and
 * on the desktop neither ever ran: `jump-1`..`jump-9` sit in the File menu, and
 * macOS matches a menu's key equivalent before the keydown reaches the page. So
 * ⌘1 over this palette switched to the first conversation in the rail and threw
 * away whatever was being composed. `claimChords` is what makes the advertisement
 * true — for the interval the claim is held, and not one keystroke longer.
 *
 * SPELLED AS CHORDS RATHER THAN AS `jump-N`, which is what survives a rebind:
 * this palette wants ⌘-and-a-digit, and has no opinion about which command
 * happens to be sitting on that chord today. Move the jumps to ⌥1..⌥9 in
 * Settings and this claim suppresses nothing, while the rows keep working.
 */
const QUICK_PICK_CHORDS = Array.from({ length: QUICK_PICK_LIMIT }, (_, index) => `CommandOrControl+${index + 1}`);

/**
 * WHERE THE PROJECT IS, as one line: "Local · /Users/you/code/telar", or the
 * Mac's own name in place of "Local" when it is on a paired one.
 *
 * THE KIND IS SAID OUT LOUD RATHER THAN IMPLIED BY ABSENCE. The row used to
 * carry the path alone and hang a little monitor chip beside the NAME for a
 * remote — so "this one is on this Mac" was something you read off the lack of a
 * chip, two columns away from the path it qualified. T3 puts the word on the
 * sub-line with the path, and the sentence answers the question in the order it
 * gets asked: which machine, then where on it.
 *
 * A PAIRED MAC'S PROJECT HAS NO PATH HERE, so the line is just the Mac. The
 * rail's aggregate read does not carry roots for other hosts, and inventing
 * "somewhere on mini" would be words standing in for a fact.
 */
export function targetPlace(target: NewConversationTarget): string {
  const where = target.hostName ?? "Local";
  return target.root ? `${where} · ${target.root}` : where;
}

/**
 * Narrow by name or by that line, so anything a reader can SEE is something they
 * can type — including the word "Local", which the row now says. Case-insensitive,
 * and a blank query is every project rather than none.
 */
export function matchTargets(targets: readonly NewConversationTarget[], query: string): NewConversationTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...targets];
  return targets.filter((target) => `${target.name} ${targetPlace(target)}`.toLocaleLowerCase().includes(needle));
}

/**
 * WHERE A PROJECT CAN COME FROM.
 *
 * `setupRequired` rows are LISTED RATHER THAN HIDDEN, which is T3's call and the
 * right one: a person looking for Bitbucket learns that Telar knows the word and
 * has not wired it up, instead of concluding the feature does not exist and
 * going to look somewhere else. They do nothing when pressed, and say so.
 */
export type ProjectSource = {
  id: string;
  title: string;
  /** The one-line sub-line under the title. Replaced by "Clone <url>" on the two
   *  clone rows once the field holds something clonable. */
  hint: string;
  icon: typeof FolderOpenIcon;
  /** Listed, greyed, chipped, and inert. */
  setupRequired?: true;
  /** This row clones whatever the field holds. */
  clones?: true;
};

export const PROJECT_SOURCES: ProjectSource[] = [
  { id: "local", title: "Local folder", hint: "Browse a folder on disk", icon: FolderOpenIcon },
  { id: "git-url", title: "Git URL", hint: "Clone from a remote URL", icon: LinkIcon, clones: true },
  { id: "github", title: "GitHub repository", hint: "Clone GitHub owner/repo", icon: GitBranchIcon, clones: true },
  { id: "azure", title: "Azure DevOps", hint: "Clone from an Azure DevOps project", icon: CloudIcon, setupRequired: true },
  { id: "bitbucket", title: "Bitbucket", hint: "Clone from a Bitbucket workspace", icon: BoxesIcon, setupRequired: true },
  { id: "forgejo", title: "Forgejo / Gitea", hint: "Clone from a self-hosted forge", icon: ServerIcon, setupRequired: true },
];

/** A URL git would take, in any of the spellings a person actually pastes. */
const GIT_URL = /^(?:https?|ssh|git):\/\/\S+$/i;
/** `git@github.com:owner/repo.git` — scp syntax, whose separator is a colon. */
const SCP_URL = /^[\w.-]+@[\w.-]+:\S+$/;
/** `owner/repo`, bare: no scheme, no host, no `@`. */
const SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * What the field would clone, if anything.
 *
 * THE FIELD IS THE URL BOX. The palette's title IS its search field, so a third
 * page with a text input in it would be a form wearing a palette's clothes —
 * and the thing a person does with a repository URL is paste it. Pasting one
 * here narrows the Sources page to the single row that would act on it.
 *
 * THE SHORTHAND IS EXPANDED BY THE ENGINE, not here: `clone.ts` owns the rule so
 * the cockpit never holds an opinion about which forge a bare pair belongs to.
 * This only decides WHICH ROW to show, and shows the typed text on it.
 */
export function cloneRequest(query: string): { source: string; url: string } | undefined {
  const url = query.trim();
  if (!url) return undefined;
  if (SHORTHAND.test(url.replace(/\.git$/, ""))) return { source: "github", url };
  if (!GIT_URL.test(url) && !SCP_URL.test(url)) return undefined;
  return { source: /github\.com/i.test(url) ? "github" : "git-url", url };
}

/**
 * The Sources rows as drawn, for this query.
 *
 * A CLONABLE QUERY COLLAPSES THE LIST TO ONE ROW, deliberately: the reader has
 * already said what they want, and offering them five other sources to arrow
 * past is asking the question again. Otherwise it is an ordinary filter over
 * everything the rows say.
 */
export function sourceRows(query: string, sources: readonly ProjectSource[] = PROJECT_SOURCES): ProjectSource[] {
  const clone = cloneRequest(query);
  if (clone) {
    const row = sources.find((source) => source.id === clone.source);
    return row ? [{ ...row, hint: `Clone ${clone.url}` }] : [];
  }
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...sources];
  return sources.filter((source) => `${source.title} ${source.hint}`.toLocaleLowerCase().includes(needle));
}

/** The last path segment — what a person calls the folder they just picked. */
export function folderName(root: string): string {
  return (
    root
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? root
  );
}

/** What the toast says, and what its Undo would take back. */
export type Registered = { projectId: string; name: string; ignored: boolean };

/**
 * THE DIALOG AROUND THE PAGES, and nothing else.
 *
 * The pages themselves are `ProjectPalettePages` below, which the COMMAND
 * PALETTE (#402) embeds in its own dialog as its "New conversation in…" and
 * "Add project" sub-pages. Two dialogs drawing the same two lists was the
 * alternative, and it is the arrangement this file already argued against once.
 *
 * THE TOAST IS OUT HERE ON PURPOSE, as it always was: registering closes the
 * palette, and a notice rendered inside a dialog that just closed is a notice
 * nobody sees.
 */
export function ProjectPalette({
  open,
  page = "projects",
  onOpenChange,
  targets,
  onChoose,
  onRegistered,
}: {
  open: boolean;
  /** Which page this opening starts on. The rail's add button says "sources";
   *  ⌘N and the New-conversation button say nothing and get "projects". */
  page?: PalettePage;
  onOpenChange: (open: boolean) => void;
  targets: readonly NewConversationTarget[];
  onChoose: (target: NewConversationTarget) => void;
  /** A project just joined the registry — re-read whatever list you draw. */
  onRegistered: () => void;
}) {
  const [toast, setToast] = useState<Registered>();

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="top-[18%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg">
          <ProjectPalettePages
            open={open}
            page={page}
            targets={targets}
            onChoose={onChoose}
            onClose={() => onOpenChange(false)}
            onRegistered={(registered) => {
              setToast(registered);
              onRegistered();
            }}
          />
        </DialogContent>
      </Dialog>

      <RegisteredToast toast={toast} onDismiss={() => setToast(undefined)} onChanged={onRegistered} />
    </>
  );
}

/**
 * THE PAGES, WITHOUT A DIALOG OF THEIR OWN — so the command palette can put
 * them inside the dialog a reader is already in.
 *
 * `onBack` IS WHAT MAKES THEM A SUB-PAGE. Given one, the first page grows a back
 * arrow and Backspace on an empty field leaves the pages altogether — which is
 * the palette's root list. Without one, this is the standalone palette it always
 * was: Sources goes back to Projects, and Projects is the floor.
 */
export function ProjectPalettePages({
  open = true,
  page: openOn,
  onClose,
  targets,
  onChoose,
  onRegistered,
  onBack,
}: {
  /** Whether the dialog around these pages is open. A flip to `true` is what
   *  resets them; the command palette mounts them fresh instead and leaves this
   *  at its default. */
  open?: boolean;
  page: PalettePage;
  /** Close the whole dialog — what choosing a row, or finishing, does. */
  onClose: () => void;
  targets: readonly NewConversationTarget[];
  onChoose: (target: NewConversationTarget) => void;
  /** A project joined the registry; here is what to say about it. */
  onRegistered: (registered: Registered) => void;
  /** Leave these pages for whatever is behind them. Absent when nothing is. */
  onBack?: () => void;
}) {
  const [page, setPage] = useState<Page>(openOn);
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  const [index, setIndex] = useState(0);
  /** A register or a clone is in flight, so the browser's own button says so
   *  rather than a spinner over the whole palette. A clone is seconds to
   *  minutes; it is the browser page that is up while it runs, which is why
   *  this is no longer which ROW is working. */
  const [busy, setBusy] = useState(false);
  /** The URL the clone pages are about, once somebody has given one. Held here
   *  rather than on the URL page, because the page that ASKS for it and the
   *  page that picks the parent are two pages and the answer outlives the
   *  first. */
  const [cloneUrl, setCloneUrl] = useState<string>();
  /** One line under the list. The palette has no other place to put a sentence,
   *  and swallowing the engine's refusal would leave a dead Enter key. */
  const [notice, setNotice] = useState<string>();

  const matches = useMemo(() => matchTargets(targets, query), [targets, query]);
  const rows = useMemo(() => sourceRows(query), [query]);
  const count = page === "projects" ? matches.length + 1 : rows.length;

  /**
   * A FRESH PALETTE EVERY TIME. A query left over from the last open would hide
   * most of the registry from somebody who pressed ⌘N expecting a list, and a
   * page left over would open the wrong one for the button they pressed.
   *
   * ADJUSTED DURING RENDER rather than in an effect, which is React's own
   * answer for "state derived from a prop change" — an effect here would set
   * state synchronously and cascade a second render, which this app's lint rule
   * refuses on exactly those grounds.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPage(openOn);
      setQuery("");
      setIndex(0);
      setBusy(false);
      setNotice(undefined);
      setCloneUrl(undefined);
    }
  }

  /**
   * THE ⌘-DIGITS ARE OURS WHILE A LIST IS UP, AND NOT OTHERWISE (#656).
   *
   * SCOPED TO THE SAME TWO PAGES `onKeyDown` ANSWERS ON. The folder browser and
   * the clone-URL page draw no numbered rows and would do nothing with ⌘1, so
   * they hand it straight back to the rail rather than holding a chord they
   * cannot use — the claim and the handler agree about which pages own digits
   * because they are written off the same condition.
   *
   * KEYED ON `open` AS WELL AS THE PAGE, so the release happens at the moment
   * the dialog is dismissed rather than when Radix finally unmounts it: the
   * content lingers for the length of the exit animation, and a couple of
   * hundred milliseconds of dead ⌘1 in the rail is a real thing a person can
   * press into. Escape, a click on the backdrop and a route change all flip
   * `open` first, so all three release on the same line — and the unmount path
   * (the command palette embeds these pages and never passes `open`) is covered
   * by the effect's own teardown.
   */
  const listPage = page === "projects" || page === "sources";
  useEffect(() => {
    if (!open || !listPage) return undefined;
    return claimChords(QUICK_PICK_CHORDS);
  }, [open, listPage]);

  const go = (next: Page) => {
    setPage(next);
    setQuery("");
    setIndex(0);
    setNotice(undefined);
  };

  /**
   * THE PAGE BACKSPACE BOTTOMS OUT ON. With nowhere further to go — the
   * standalone palette — Projects IS the floor, because both doors converge
   * there and it is a legitimate place to arrive at from either.
   */
  const backRoot: PalettePage = onBack ? openOn : "projects";
  /** Which of the two lists is up, for the shared back rule. The pages below
   *  this one never ask: they own their own keys. */
  const list: PaletteSubPage = page === "sources" ? "sources" : "projects";
  const backsTo = paletteBack(list, "", backRoot);
  const goBack = () => {
    if (backsTo === "projects") go("projects");
    else onBack?.();
  };

  const choose = (target: NewConversationTarget | undefined) => {
    if (!target) return;
    onClose();
    onChoose(target);
  };

  /**
   * WHAT HAPPENS AFTER A PROJECT EXISTS, once, for both ways in.
   *
   * THE GITIGNORE IS A SECOND REQUEST AND ITS FAILURE IS NOT THE PROJECT'S. The
   * project is registered by the time this runs, so a `.gitignore` that could not
   * be written — a read-only checkout, a permission problem — reports itself and
   * leaves the project in place. Folding the two into one call would mean losing
   * a perfectly good registration to a file write.
   *
   * AND IT IS NO LONGER A SWITCH IN THE FLOW. It was a toggle in the old dialog,
   * off by default, which asked everybody a question about `.gitignore` on the
   * way into their first project. It is a default now, and the toast carries the
   * Undo — a decision you can reverse afterwards beats a decision you have to
   * make first.
   */
  const settle = async (project: { id: string; name: string }) => {
    announceProjectsChanged();
    let ignored = true;
    try {
      await api.projectGitignore(project.id);
    } catch {
      ignored = false;
    }
    onClose();
    onRegistered({ projectId: project.id, name: project.name, ignored });
  };

  const failed = (cause: unknown) => setNotice(cause instanceof EngineApiError ? cause.message : String(cause));

  /** Register a folder that already holds a repository. */
  const addLocalFolder = async (root: string) => {
    setNotice(undefined);
    setBusy(true);
    try {
      await settle((await api.registerProject({ name: folderName(root), root })).project);
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Clone the URL the reader gave into the folder they picked.
   *
   * THE PARENT IS ASKED FOR, never assumed. Telar has no "code folder" setting
   * and inventing one here would put somebody's repository in a directory they
   * would then have to go and find.
   */
  const cloneInto = async (parent: string) => {
    if (!cloneUrl) return;
    setNotice(undefined);
    setBusy(true);
    try {
      await settle((await api.cloneProject({ url: cloneUrl, parent })).project);
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };

  /**
   * THE NATIVE PICKER, STILL HERE FOR THE ONE CASE THE BROWSER CANNOT COVER:
   * an engine the cockpit cannot reach. The listing comes over HTTP, so a
   * browser with no adapter behind it is a dead end — while `chooseDirectory`
   * goes through the desktop shell's own IPC and keeps working. Offered by
   * name from the browser's footer, never silently substituted.
   */
  const pickWithSystem = (title: string, then: (path: string) => void) => {
    void chooseDirectory({ title }).then((chosen) => {
      if ("cancelled" in chosen) return;
      if ("unavailable" in chosen) {
        setNotice(chosen.unavailable);
        return;
      }
      then(chosen.path);
    });
  };

  /**
   * A SOURCE ROW NO LONGER DOES THE WHOLE JOB — it opens the page that does.
   *
   * It used to press a button and get a Finder sheet, which is the gesture this
   * replaces. "Local folder" walks to the browser; the two clone rows walk to
   * the URL page, or straight past it to the parent browser when the field
   * already holds something clonable — a reader who pasted a URL has answered
   * that question and should not be asked it twice.
   */
  const pickSource = (source: ProjectSource | undefined) => {
    if (!source || busy) return;
    if (source.setupRequired) {
      setNotice(`${source.title} is not set up yet. Clone it yourself and add it as a local folder.`);
      return;
    }
    if (!source.clones) {
      go("local");
      return;
    }
    const clone = cloneRequest(query);
    setCloneUrl(clone?.url);
    go(clone ? "clone-parent" : "clone-url");
  };

  /** The URL page's Enter. A clonable value walks on; anything else says what
   *  is wrong rather than being a dead key. */
  const takeCloneUrl = (typed: string) => {
    const clone = cloneRequest(typed);
    if (!clone) {
      setNotice("That is not a clone URL. Paste an https, ssh or git URL — or owner/repo.");
      return;
    }
    setCloneUrl(clone.url);
    go("clone-parent");
  };

  const take = (at: number) => {
    if (page === "sources") {
      pickSource(rows[at]);
      return;
    }
    // The last row on Projects is the door to Sources, so the arrows reach it
    // like any other row rather than it being chrome you have to mouse to.
    if (at >= matches.length) go("sources");
    else choose(matches[at]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // THE LIST PAGES ONLY. The browser and the URL page own their own fields
    // and their own keys — Backspace goes UP in a folder browser, and this
    // would have sent it back to Projects instead.
    if (page !== "projects" && page !== "sources") return;
    // An IME's own Enter commits a candidate; it is not a selection.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      take(Number(event.key) - 1);
      return;
    }
    // ONLY ON AN EMPTY FIELD — see `paletteBack`, which is where that rule
    // lives now that the command palette leans on it too.
    if (event.key === "Backspace" && paletteBack(list, query, backRoot)) {
      event.preventDefault();
      goBack();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex((current) => (current + delta + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      take(index);
    }
  };

  const at = count === 0 ? -1 : Math.min(index, count - 1);

  return (
    /* `contents`, SO THE DIALOG'S OWN LAYOUT IS UNCHANGED by there being a
       component here at all: the pages are the popup's children as they always
       were, and this box exists only to catch the keys — which bubble to it from
       the field regardless of how it lays out. */
    <div className="contents" onKeyDown={onKeyDown}>
      {/* The title and the sentence are for a screen reader; the palette's own
          chrome is the field and the list. They name the PAGE, which is why they
          live here rather than on the dialog: the dialog outlives the page, and
          on the command palette it is not even ours. */}
      <DialogTitle className="sr-only">{PAGE_TITLES[page]}</DialogTitle>
      <DialogDescription className="sr-only">{PAGE_SENTENCES[page]}</DialogDescription>

      {page === "local" || page === "clone-parent" ? (
            /* THE FOLDER BROWSER, in place of the field and the list — T3's
               shape, and what replaces the Finder sheet this flow used to
               open. The clone button says "Clone here" because the folder it
               takes is the PARENT of the checkout, not the checkout. */
            <DirectoryBrowser
              actionLabel={page === "local" ? "Add" : "Clone here"}
              busy={busy}
              {...(notice ? { notice } : {})}
              onBack={() => go("sources")}
              onSubmit={(root) => void (page === "local" ? addLocalFolder(root) : cloneInto(root))}
              onFallback={() =>
                pickWithSystem(
                  page === "local" ? "Choose a project folder for Telar" : "Choose the folder to clone into",
                  (root) => void (page === "local" ? addLocalFolder(root) : cloneInto(root)),
                )
              }
            />
          ) : page === "clone-url" ? (
            <CloneUrlPage
              {...(notice ? { notice } : {})}
              onBack={() => go("sources")}
              onSubmit={takeCloneUrl}
              onChange={() => setNotice(undefined)}
            />
          ) : (
            <>
          {/* THE FIELD IS THE TITLE, with the back arrow in front of it — T3's
              shape, and the reason the pages need no heading of their own. */}
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            {/* A BACK ARROW WHENEVER THERE IS SOMEWHERE TO GO. Sources always
                has one; Projects grows one only as a sub-page of the command
                palette, where what is behind it is that palette's own list. */}
            {page === "sources" || onBack ? (
              <button
                type="button"
                aria-label={backsTo === "projects" ? "Back to projects" : "Back"}
                title={backsTo === "projects" ? "Back to projects" : "Back"}
                onClick={goBack}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            ) : (
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
                setNotice(undefined);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              placeholder={page === "sources" ? "Search sources, or paste a repository URL" : "Search projects"}
              aria-label={page === "sources" ? "Search sources, or paste a repository URL" : "Search projects"}
              role="combobox"
              aria-expanded={count > 0}
              aria-controls="project-palette-results"
              aria-activedescendant={at >= 0 ? `project-palette-${page}-${at}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div
            id="project-palette-results"
            role="listbox"
            aria-label={page === "sources" ? "Sources" : "Projects"}
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {/* THE CAPTION NAMES THE LIST, WHICH THE FIELD NO LONGER CAN. The
                field is the title and it says what you may TYPE ("Search
                projects"), not what you are looking at — and with two pages
                behind one field, "which list is this" is a real question a
                reader can now arrive at from either side. T3 captions both. */}
            <p aria-hidden className="px-2 pt-1 pb-1.5 text-2xs font-medium text-muted-foreground">
              {page === "sources" ? "Sources" : "Projects"}
            </p>
            {page === "projects" ? (
              <>
                {matches.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {targets.length === 0 ? "No projects registered yet." : "No project matches that."}
                  </p>
                )}
                {matches.map((target, row) => (
                  <PaletteRow
                    key={`${target.hostId ?? "local"}:${target.id}`}
                    id={`project-palette-projects-${row}`}
                    on={row === at}
                    onPick={() => choose(target)}
                    onHover={() => setIndex(row)}
                    glyph={
                      <ProjectAvatar
                        name={target.name}
                        {...(target.hostId ? {} : { projectId: target.id })}
                        {...(target.icon ? { icon: target.icon } : {})}
                        {...(target.iconName ? { iconName: target.iconName } : {})}
                        size={16}
                      />
                    }
                    title={target.name}
                    hint={targetPlace(target)}
                    mono
                    {...(row < QUICK_PICK_LIMIT ? { key9: row + 1 } : {})}
                  />
                ))}
                {/* THE DOOR TO THE OTHER PAGE IS A ROW, not a button in the
                    chrome: it is one of the things you might be looking for when
                    you open this, so it belongs in the list the arrows walk. */}
                <PaletteRow
                  id={`project-palette-projects-${matches.length}`}
                  on={at === matches.length}
                  onPick={() => go("sources")}
                  onHover={() => setIndex(matches.length)}
                  glyph={<FolderPlusIcon className="size-4 text-muted-foreground" />}
                  title="Add a project…"
                  hint="A folder on this Mac, or a repository to clone"
                />
              </>
            ) : (
              <>
                {rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No source matches that.</p>}
                {rows.map((source, row) => (
                  <PaletteRow
                    key={source.id}
                    id={`project-palette-sources-${row}`}
                    on={row === at}
                    dim={Boolean(source.setupRequired)}
                    onPick={() => pickSource(source)}
                    onHover={() => setIndex(row)}
                    // NO SPINNER HERE ANY MORE. A row used to open a Finder
                    // sheet and then register or clone, so it span while that
                    // ran; now it walks to a page, and the work happens with
                    // that page's own button saying so.
                    glyph={<source.icon className="size-4 text-muted-foreground" />}
                    title={source.title}
                    hint={source.hint}
                    mono={source.hint.startsWith("Clone ")}
                    badge={
                      source.setupRequired ? (
                        <span className="shrink-0 rounded border px-1.5 py-0.5 text-3xs text-muted-foreground">Setup Required</span>
                      ) : undefined
                    }
                  />
                ))}
              </>
            )}
          </div>

          {notice && (
            <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
              {notice}
            </p>
          )}

          {/* THE LEGEND IS THE FEATURE. A palette whose keys are undiscoverable
              is a list people click, and the ⌘1..⌘9 on the rows only make sense
              once something says the whole keyboard works here. Backspace joins
              it only on the page that HAS a back — a legend that names a key
              which does nothing is worse than a shorter legend. */}
          <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
            <span>
              <kbd className="font-sans">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="font-sans">Enter</kbd> Select
            </span>
            {(page === "sources" || onBack) && (
              <span>
                <kbd className="font-sans">Backspace</kbd> Back
              </span>
            )}
            <span>
              <kbd className="font-sans">Esc</kbd> Close
            </span>
          </div>
            </>
          )}
    </div>
  );
}

/**
 * PASTE THE REPOSITORY, ON ITS OWN PAGE.
 *
 * IT USED TO BE THE SEARCH FIELD. The Sources page narrowed to one row when
 * what you had typed looked clonable, which was neat and made the field two
 * things at once: a filter over six rows, and the URL box. Somebody who chose
 * "Git URL" without having pasted anything first got a sentence telling them to
 * go and type in the field they had just left — a dead Enter key dressed up as
 * guidance. T3 Code gives it a page, and the page can say what it wants.
 *
 * THE FIELD STAYS IN THE PALETTE'S OWN SHAPE — back arrow, then the input, no
 * heading — so this reads as the same dialog one step along. The sentence under
 * it is T3's.
 *
 * PASTING INTO THE SEARCH FIELD STILL WORKS and still skips this page: a reader
 * who already answered the question is not asked it again (`pickSource`).
 */
function CloneUrlPage({
  notice,
  onBack,
  onSubmit,
  onChange,
}: {
  notice?: string;
  onBack: () => void;
  onSubmit: (url: string) => void;
  onChange: () => void;
}) {
  const [url, setUrl] = useState("");

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          aria-label="Back to sources"
          title="Back to sources"
          onClick={onBack}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <input
          autoFocus
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            onChange();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            onSubmit(url);
          }}
          placeholder="https://github.com/owner/repo.git"
          aria-label="Git clone URL"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        Enter a Git clone URL and press Enter to continue
      </p>

      {notice && (
        <p className="border-t px-3 py-2 text-2xs leading-snug text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <kbd className="font-sans">Enter</kbd> Continue
        </span>
        <span>
          <kbd className="font-sans">Esc</kbd> Close
        </span>
      </div>
    </>
  );
}

/**
 * ONE ROW ANATOMY FOR EVERY PAGE — glyph, title, sub-line, a badge, and one
 * trailing mark (a ⌘digit here, a command's chord in the command palette).
 *
 * Written once because the pages differ in what fills those slots and in
 * nothing else; two copies would be where the highlight, the hover rule and the
 * aria wiring quietly drift apart. EXPORTED for the command palette (#402) for
 * exactly that reason: its rows are these rows.
 */
export function PaletteRow({
  id,
  on,
  dim,
  onPick,
  onHover,
  glyph,
  title,
  hint,
  mono,
  badge,
  key9,
  trailing,
}: {
  id: string;
  on: boolean;
  dim?: boolean;
  onPick: () => void;
  onHover: () => void;
  glyph: React.ReactNode;
  title: string;
  hint?: string;
  mono?: boolean;
  badge?: React.ReactNode;
  key9?: number;
  /** The row's right-hand end, when it is not a ⌘digit. */
  trailing?: React.ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={on}
      onClick={onPick}
      // Pointing at a row makes it the one Enter would take, so the mouse and
      // the arrows never disagree about what is selected.
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        dim && "opacity-60",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{title}</span>
          {badge}
        </span>
        {hint && (
          <span className={cn("block truncate text-2xs text-muted-foreground", mono && "font-mono")}>{hint}</span>
        )}
      </span>
      {key9 !== undefined && <kbd className="shrink-0 font-sans text-3xs text-muted-foreground/60">⌘{key9}</kbd>}
      {trailing}
    </button>
  );
}

/**
 * WHAT JUST HAPPENED, AND HOW TO TAKE IT BACK.
 *
 * THE ONLY REASON THIS EXISTS is the `.gitignore` default. Registering a project
 * now writes three lines into somebody's repository without asking — the switch
 * became a default — and a write nobody opted into needs a way back that is as
 * cheap as the way in and is in front of them when it happens.
 *
 * IT IS NOT A TOAST SYSTEM. There is no queue, no provider, no store: one
 * notice, owned by the palette that caused it, replaced if a second registration
 * follows. A general toast layer is a thing this app may want one day; inventing
 * it for one notice would be a lot of surface for one sentence.
 *
 * IT GOES AWAY ON ITS OWN, because an undo nobody takes should not become
 * furniture — and it carries a ✕ because a timer is not a promise.
 *
 * EXPORTED for the command palette, which embeds the pages above in its own
 * dialog and therefore inherits the job of saying what just happened.
 */
export function RegisteredToast({
  toast,
  onDismiss,
  onChanged,
}: {
  toast: { projectId: string; name: string; ignored: boolean } | undefined;
  onDismiss: () => void;
  onChanged: () => void;
}) {
  /**
   * WHICH project was undone, not whether one was — so a second registration
   * needs no reset. Storing a boolean meant clearing it when the toast changed,
   * and the only place to do that is an effect, which this app's lint rule
   * refuses for exactly the cascading-render reason it gives.
   */
  const [undone, setUndone] = useState<string>();
  const key = toast?.projectId;

  useEffect(() => {
    if (!key) return undefined;
    const timer = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(timer);
  }, [key, onDismiss]);

  if (!toast) return null;
  const reversed = undone === toast.projectId;

  const undo = () => {
    setUndone(toast.projectId);
    void api
      .undoProjectGitignore(toast.projectId)
      .then(() => onChanged())
      .catch(() => setUndone(undefined));
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-3"
    >
      <span className="min-w-0 flex-1 text-xs leading-snug">
        <span className="block font-medium">{toast.name} was added.</span>
        <span className="mt-0.5 block text-muted-foreground">
          {!toast.ignored
            ? "Telar's files could not be added to its .gitignore."
            : reversed
              ? "Those rules were taken back out of its .gitignore."
              : "Telar's files are ignored in its .gitignore."}
        </span>
      </span>
      {toast.ignored && !reversed && (
        <button
          type="button"
          onClick={undo}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Undo2Icon className="size-3.5" />
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
