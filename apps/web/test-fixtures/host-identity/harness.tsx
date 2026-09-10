/**
 * #204 regression harness: THE REAL `AppSidebar`, two fake Macs, one rail.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND COPY OF THE RAIL'S LOGIC. The earlier
 * reproduction (`reproduce.ts`) mirrors `loadAll`, so it can prove the defect
 * but not the fix: correcting `app-sidebar.tsx` would leave the mirror
 * unchanged and still failing. This mounts the actual component, lets the
 * address bar be a control, and reads its verdict off the RENDERED hrefs — so
 * it fails today and passes only when the rail itself pins its local read.
 *
 * THE ASSERTION, in one sentence: a row served by engine X must link to
 * engine X. Titles carry their engine ("REMOTE B — …"), hrefs carry their host
 * prefix, and any row whose href names a different Mac than the read that
 * produced it is a leak, listed in red.
 *
 * Everything outside the component is stubbed and local: `next/navigation` and
 * `next/link` are fixture stubs (see ./stubs), and the wire is `makeWire()`.
 * No pairing store, no live Mac, no installed app.
 */
import { createElement as h, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "../../components/app-sidebar";
import { FreshGreeting } from "../../components/session/fresh-greeting";
import { announceProjectsChanged } from "../../lib/projects";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SIDEBAR_CACHE_KEY } from "../../lib/sidebar-cache";
import { BOOK, ENGINES, LOCAL_ENGINE, makeWire, SHARED_SESSION } from "./engines";
import { fixturePathname, pushed, setFixturePathname } from "./stubs/next-navigation";
import { SHARED_PROJECT } from "./engines";

// ── the world, installed before anything mounts ───────────────────────────

/** Containers, addressed by id so the helpers need no refs. */
const GREETING_ID = "greeting-host";

const wire = makeWire();
(globalThis as { fetch: typeof fetch }).fetch = wire.fetch;

/** Which engine a row's title says it came from. */
function engineOfTitle(title: string): string | undefined {
  for (const [id, engine] of Object.entries(ENGINES)) {
    if (engine.sessions.some((session) => session.title === title)) return id;
  }
  return undefined;
}

/** Which Mac an href addresses: `/hosts/:id/…` names one, anything else local. */
function engineOfHref(href: string): string {
  const match = /^\/hosts\/([^/]+)\//.exec(href);
  return match ? decodeURIComponent(match[1]!) : LOCAL_ENGINE;
}

type Row = { title: string; href: string; from?: string; to: string; ok: boolean };

/** Every session row the rail rendered, judged against its own engine.
 *  A title that exists on BOTH Macs is not judged here — it cannot identify
 *  its engine, and the shared-id case is checked by following it instead. */
function readRail(): Row[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('#rail a[href*="/sessions/"]'));
  const rows: Row[] = [];
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    const title = (anchor.textContent ?? "").trim();
    const known = Object.values(ENGINES)
      .flatMap((engine) => engine.sessions)
      .find((session) => title.includes(session.title));
    if (!known) continue;
    const shared = Object.values(ENGINES).filter((engine) => engine.sessions.some((session) => session.id === known.id)).length > 1;
    const from = engineOfTitle(known.title);
    const to = engineOfHref(href);
    rows.push({ title: known.title, href, ...(from ? { from } : {}), to, ok: shared ? true : from === to });
  }
  return rows;
}

// ── scenarios ─────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Control = {
  standAt: (pathname: string) => void;
  /** Open the greeting's project menu, press a project that is NOT the current
   *  one, and answer with the url it asked the router for — or a sentence
   *  saying why it could not. */
  pickProject: () => Promise<string>;
  /**
   * Make the rail read again, the way the app does. Its own 10s timer is
   * throttled to nothing in a background tab, and the registry announcement is
   * a REAL trigger — `announceProjectsChanged` is what registering a project
   * calls, and the rail listens for it (app-sidebar.tsx:514). A remount
   * (`reload`) is the other real trigger: the app opened on a remote URL.
   */
  poll: () => Promise<void>;
  reload: () => void;
  hold: (on: boolean) => void;
  release: (engine?: string) => number;
  log: (line: string) => void;
};

type Scenario = { name: string; note: string; run: (control: Control) => Promise<void> };

const SCENARIOS: Scenario[] = [
  {
    name: "1 · local rail read while the address is remote B",
    note: "The rail polls every Mac. Standing on /hosts/host_b/…, its LOCAL read must still reach this Mac — and B's rows must keep B's prefix.",
    run: async ({ standAt, poll, log }) => {
      standAt("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
      wire.hops.length = 0;
      await poll();
      const local = wire.hops.filter((hop) => hop.pathname === "/api/sessions/live");
      log(`the read labelled LOCAL asked: ${local.length > 0 ? "this Mac (/api/sessions/live)" : "NOT this Mac"}`);
      const toB = wire.hops.filter((hop) => hop.pathname === "/api/hosts/host_b/sessions/live").length;
      log(`reads that reached host_b in this pass: ${toB}${toB > 1 ? "  ← read twice, once labelled local" : ""}`);
    },
  },
  {
    name: "2 · remote A → remote B → local → remote B",
    note: "Each move re-polls. No row may change which Mac it links to because of where the reader happens to be standing.",
    run: async ({ standAt, poll, log }) => {
      for (const at of [
        "/hosts/host_a/projects/project_9ab0/sessions/session_a1",
        "/hosts/host_b/projects/project_9ab0/sessions/session_b1",
        "/projects/project_9ab0/sessions/session_local1",
        "/hosts/host_b/projects/project_9ab0/sessions/session_b1",
      ]) {
        standAt(at);
        await poll();
        const bad = readRail().filter((row) => !row.ok);
        log(`at ${at} → ${bad.length === 0 ? "every row links to its own Mac" : `${bad.length} mislinked`}`);
      }
    },
  },
  {
    name: "3 · the shared session id, followed",
    note: "One id exists on every Mac. Clicking B's row must ask B — asking this Mac would open a different conversation with no error at all.",
    run: async ({ standAt, poll, log }) => {
      standAt("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
      await poll();
      const shared = readRail().filter((row) => row.href.includes(SHARED_SESSION));
      for (const row of shared) log(`shared-id row → ${row.href} → would ask ${engineOfHref(row.href)}`);
      const asksB = shared.some((row) => engineOfHref(row.href) === "host_b");
      log(asksB ? "at least one shared-id row addresses host_b" : "NO shared-id row addresses host_b — B's copy is unreachable from the rail");
    },
  },
  {
    name: "4 · host-scoped cache, across a reload",
    note: "The rail caches each Mac's last rows under that Mac's key. A reload from cache must not resurrect one Mac's rows as another's.",
    run: async ({ standAt, poll, reload, log }) => {
      standAt("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
      await poll();
      const raw = window.localStorage.getItem(SIDEBAR_CACHE_KEY) ?? "{}";
      const cache = JSON.parse(raw) as Record<string, { sessions: { id: string; title: string; hostId?: string }[] }>;
      for (const [host, entry] of Object.entries(cache)) {
        const foreign = entry.sessions.filter((session) => engineOfTitle(session.title) !== undefined && engineOfTitle(session.title) !== host);
        log(`cache[${host}]: ${entry.sessions.length} rows${foreign.length ? ` — ${foreign.length} belong to another Mac (${foreign.map((row) => row.title).join(", ")})` : ""}`);
      }
      reload();
      await wait(1500);
      const bad = readRail().filter((row) => !row.ok);
      log(`reloaded from cache → ${bad.length === 0 ? "rows still link to their own Mac" : `${bad.length} mislinked`}`);
    },
  },
  {
    name: "6 · the greeting picker, with a reply held across a host switch",
    note: "The canvas picker lists ONE Mac's projects. Its read is held while the reader moves from B to A; when it lands it must not be shown, and picking a project must push that Mac's own canvas — the project id is the same string on every engine.",
    run: async ({ standAt, hold, release, log, pickProject }) => {
      standAt(`/hosts/host_b/projects/${SHARED_PROJECT}/sessions/new`);
      await wait(700);
      log(`on host_b the picker → ${await pickProject()}`);

      // The read for A is parked; the reader goes back to B before it answers.
      hold(true);
      standAt(`/hosts/host_a/projects/${SHARED_PROJECT}/sessions/new`);
      await wait(300);
      standAt(`/hosts/host_b/projects/${SHARED_PROJECT}/sessions/new`);
      await wait(200);
      log(`held ${wire.parked()} replies across the switch`);
      release();
      hold(false);
      await wait(700);
      const after = await pickProject();
      log(`after the late reply the picker → ${after}`);
      log(
        after.startsWith("/hosts/host_b/")
          ? "the picker stayed on host_b"
          : `LEAK or blocked: ${after} while the canvas is host_b`,
      );

      standAt(`/projects/${SHARED_PROJECT}/sessions/new`);
      await wait(700);
      log(`on this Mac the picker → ${await pickProject()}`);
    },
  },
  {
    name: "5 · a rail read that lands after the move",
    note: "The read is held, the reader moves on, then it answers. It may not publish rows addressed to the Mac that has been left.",
    run: async ({ standAt, poll, hold, release, log }) => {
      standAt("/hosts/host_a/projects/project_9ab0/sessions/session_a1");
      await poll();
      hold(true);
      // A pass begun on A, then the reader moves to B before it answers.
      const inFlight = poll();
      await wait(300);
      standAt("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
      await wait(200);
      log(`held ${wire.parked()} replies across the move`);
      release();
      hold(false);
      await inFlight;
      await wait(600);
      const bad = readRail().filter((row) => !row.ok);
      log(bad.length === 0 ? "late rows arrived correctly addressed" : `${bad.length} rows mislinked after the late arrival`);
    },
  },
];

// ── the page ──────────────────────────────────────────────────────────────

function App() {
  const [generation, setGeneration] = useState(0);
  const [running, setRunning] = useState<string>();
  const [lines, setLines] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [at, setAt] = useState(fixturePathname());

  const log = useCallback((line: string) => setLines((current) => [...current, line].slice(-14)), []);

  useEffect(() => {
    const timer = setInterval(() => {
      setRows(readRail());
      setAt(fixturePathname());
    }, 300);
    return () => clearInterval(timer);
  }, []);

  const control: Control = {
    standAt: (pathname) => setFixturePathname(pathname),
    pickProject: async () => {
      const before = pushed.length;
      // Any menu still open (or still closing) from a previous press swallows
      // the next one, so start from a closed menu.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(80);
      const trigger = document.querySelector<HTMLButtonElement>(`#${GREETING_ID} button[aria-label^="Project:"]`);
      if (!trigger) return "no picker rendered";
      // A full pointer sequence, not a bare click: the menu primitive opens on
      // pointerdown, and a synthetic click alone leaves it shut. Twice if
      // needed — the first press can land while the portal is unmounting.
      const open = async () => {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        await wait(150);
        return document.querySelectorAll('[role="menuitem"]').length > 0;
      };
      if (!(await open())) await open();
      // The menu renders into a portal, so its items are looked up
      // document-wide. "notes" is the second project each engine has; the
      // shared one is the canvas's own, and switching to where you already are
      // is not a navigation.
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      if (items.length === 0) return "menu did not open";
      const target = items.find((node) => (node.textContent ?? "").includes("notes"));
      if (!target) return `no switchable project offered (${items.map((node) => node.textContent).join(" | ")})`;
      target.click();
      return pushed.length > before ? pushed[pushed.length - 1] : "pressed, but nothing was pushed";
    },
    poll: async () => {
      announceProjectsChanged();
      // Long enough for the pass's three reads per Mac to settle.
      await wait(700);
    },
    reload: () => setGeneration((value) => value + 1),
    hold: (on) => wire.hold(on),
    release: (engine) => wire.release(engine),
    log,
  };

  const leaks = rows.filter((row) => !row.ok);

  return h(
    "div",
    null,
    h(
      "div",
      { className: "controls" },
      ...SCENARIOS.map((scenario) =>
        h(
          "button",
          {
            key: scenario.name,
            disabled: running !== undefined,
            onClick: () => {
              wire.hops.length = 0;
              pushed.length = 0;
              setLines([]);
              setRunning(scenario.name);
              void scenario
                .run(control)
                .finally(() => {
                  wire.hold(false);
                  setRunning(undefined);
                });
            },
          },
          scenario.name,
        ),
      ),
    ),
    h(
      "div",
      { className: "controls" },
      h("button", { onClick: () => setFixturePathname("/projects/project_9ab0/sessions/session_local1") }, "stand: local"),
      ...BOOK.map((host) =>
        h("button", { key: host.id, onClick: () => setFixturePathname(`/hosts/${host.id}/projects/project_9ab0/sessions/session_b1`) }, `stand: ${host.id}`),
      ),
      h("button", { onClick: () => void control.poll() }, "poll now (registry announcement)"),
      h("button", { onClick: () => control.reload() }, "reload rail (keep cache)"),
      h(
        "button",
        {
          onClick: () => {
            window.localStorage.removeItem(SIDEBAR_CACHE_KEY);
            control.reload();
          },
        },
        "clear cache + reload",
      ),
      h("button", { onClick: () => wire.release() }, `release ${wire.parked()} parked`),
    ),
    h("div", { className: "meta" }, `address: ${at}`),
    h("div", { className: "meta" }, running ? `running: ${running}` : "idle"),
    ...SCENARIOS.filter((scenario) => scenario.name === running).map((scenario) => h("p", { key: scenario.name, className: "note" }, scenario.note)),
    h(
      "div",
      { className: leaks.length ? "verdict bad" : "verdict good" },
      leaks.length
        ? `${leaks.length} row(s) link to the wrong Mac: ${leaks.map((row) => `"${row.title}" served by ${row.from} → ${row.href}`).join(" · ")}`
        : `${rows.length} rendered row(s), each linking to the Mac that served it`,
    ),
    h("pre", { className: "log" }, lines.join("\n") || "no scenario run yet"),
    h(
      "pre",
      { className: "log" },
      rows.length
        ? rows.map((row) => `${row.ok ? "ok  " : "LEAK"}  ${(row.from ?? "?").padEnd(10)} ${row.title.padEnd(24)} → ${row.href}`).join("\n")
        : "no rows rendered yet",
    ),
    h("pre", { className: "log" }, `requests (newest last):\n${wire.hops.slice(-12).map((hop) => `${hop.reachedEngine.padEnd(10)} ${hop.pathname} → ${hop.status}`).join("\n") || "none"}`),
    // Both real components, remounted on `generation` — which is the reload.
    h(
      "div",
      { className: "greeting", id: GREETING_ID },
      h(FreshGreeting, { key: `${generation}:greeting`, projectId: SHARED_PROJECT, projectName: "telar" }),
    ),
    h("div", { className: "rail", id: "rail" }, h(SidebarProvider, { key: generation }, h(AppSidebar))),
  );
}

createRoot(document.getElementById("root")!).render(h(App));
