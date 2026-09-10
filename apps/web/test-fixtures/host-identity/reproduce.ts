/**
 * #204 — two Macs, one rail: where a session's host identity is lost.
 *
 * WHAT THIS IS. An isolated reproduction of the routing defect behind
 * "Request failed — session does not exist" when a conversation is picked from
 * the sidebar while the address bar is on a remote Mac. It runs PRODUCTION
 * code — `createEngineApi`, `pathnameFetcher`, `hostFetcher`, `toSidebarSession`,
 * `sessionHref`, `rememberRows`/`staleRows`, `dedupeAcrossHosts` — against two
 * fake engines with deliberately overlapping session and project ids, and
 * prints where every request actually went.
 *
 * WHAT IT IS NOT. It does not execute `app-sidebar.tsx`'s `loadAll`, which is
 * not exported; it composes the same calls in the same order, and each step
 * cites the line it mirrors. Nothing here touches a live host, a pairing store
 * or the installed app: both engines are functions in this file.
 *
 * NOT THE REGRESSION TEST, and it must not be mistaken for one: because it
 * mirrors the rail rather than running it, fixing `app-sidebar.tsx` cannot make
 * this file pass or fail differently. It therefore reports BOTH compositions
 * side by side — the pathname-following local read the defect had, and the
 * pinned one the fix uses — and always exits 0. The regression test is
 * `harness.tsx`, which mounts the real component and can be built with the
 * pre-fix line restored (`BEFORE=1 bun run build.mjs`).
 *
 * Run: bun run apps/web/test-fixtures/host-identity/reproduce.ts
 */

import { createEngineApi } from "../../lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID, pathnameFetcher } from "../../lib/hosts/client";
import { rememberRows, staleRows, type SidebarCache } from "../../lib/sidebar-cache";
import { dedupeAcrossHosts } from "../../lib/session-groups";
import { sessionHref, toSidebarSession, type SidebarSession } from "../../lib/session-list";
import type { Project, Session } from "@telar/engine-client";

// ── two engines, with ids that collide on purpose ─────────────────────────

/** The SAME session id and the SAME project id exist on both Macs, which is
 *  legal: ids are minted per engine. Nothing may rely on them differing. */
const SHARED_SESSION = "session_7b1c";
const SHARED_PROJECT = "project_9ab0";

type Engine = { daemonId: string; label: string; sessions: Session[]; projects: Project[] };

const session = (id: string, title: string, projectId: string): Session =>
  ({
    id,
    title,
    projectId,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    state: "active",
    driver: "claude",
    envMode: "local",
    workspace: { mode: "local", path: "/x" },
  }) as unknown as Session;

const project = (id: string, name: string): Project => ({ id, name }) as unknown as Project;

const LOCAL: Engine = {
  daemonId: "dmn_local",
  label: "this Mac",
  sessions: [session(SHARED_SESSION, "LOCAL — shared id", SHARED_PROJECT), session("session_local1", "LOCAL — only here", SHARED_PROJECT)],
  projects: [project(SHARED_PROJECT, "telar")],
};

const REMOTE_B: Engine = {
  daemonId: "dmn_remote_b",
  label: "mac.lan",
  sessions: [session(SHARED_SESSION, "REMOTE B — shared id", SHARED_PROJECT), session("session_b1", "REMOTE B — only there", SHARED_PROJECT)],
  // Same name as the local project, which the issue calls out: a duplicate name
  // is not evidence of broken identity, so the fixture has one.
  projects: [project(SHARED_PROJECT, "telar")],
};

const ENGINES: Record<string, Engine> = { [LOCAL_HOST_ID]: LOCAL, host_b: REMOTE_B, host_a: { ...REMOTE_B, daemonId: "dmn_remote_a", label: "studio.lan" } };

// ── the wire, recorded ────────────────────────────────────────────────────

type Hop = { pathname: string; reachedEngine: string; status: number };
const hops: Hop[] = [];
/** Requests parked until released, so a reply can land after a navigation. */
const parked: Array<() => void> = [];
let holdReplies = false;

/** Which engine a cockpit path actually reaches — the proxy's rule, not a guess:
 *  `/api/hosts/:id/*` goes to that Mac, anything else to this one. */
function routeTo(pathname: string): { engine: string; rest: string } {
  const match = /^\/api\/hosts\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return { engine: LOCAL_HOST_ID, rest: pathname.slice("/api".length) };
  return { engine: decodeURIComponent(match[1]!), rest: match[2] ?? "/" };
}

const recordingFetch = (async (input: string | URL | Request) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : new URL((input as Request).url).pathname;
  const pathname = raw.split("?")[0]!;
  const { engine, rest } = routeTo(pathname);
  const target = ENGINES[engine];
  const answer = (status: number, body: unknown) => {
    hops.push({ pathname, reachedEngine: engine, status });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };

  const reply = () => {
    // An unknown host is the proxy's own 404; an unknown session is the
    // engine's. The issue asks for these to be told apart, so they are.
    if (!target) return answer(404, { error: { code: "not_found", message: "No such host." } });
    if (rest === "/sessions/live") return answer(200, { sessions: target.sessions, projects: target.projects });
    if (rest === "/health") return answer(200, { version: 2, daemonId: target.daemonId, protocol: 2 });
    if (rest === "/inbox") return answer(200, { inbox: { autoSettleAfterHours: 72 } });
    if (rest === "/hosts" || rest === "/hosts/") return answer(200, { hosts: [{ id: "host_b", name: "mac.lan" }] });
    const found = /^\/sessions\/([^/]+)$/.exec(rest);
    if (found) {
      const id = decodeURIComponent(found[1]!);
      const known = target.sessions.some((entry) => entry.id === id);
      return known
        ? answer(200, { session: target.sessions.find((entry) => entry.id === id), turns: [], items: [], requests: [], tasks: [], cursor: 0 })
        : answer(404, { error: { code: "not_found", message: "This session does not exist." } });
    }
    return answer(404, { error: { code: "not_found", message: "No such route." } });
  };

  if (!holdReplies) return reply();
  return new Promise<Response>((resolve) => parked.push(() => resolve(reply())));
}) as unknown as typeof fetch;

/** Where the browser thinks it is. `pathnameFetcher` reads this per call. */
function standAt(pathname: string): void {
  (globalThis as { window?: unknown }).window = { location: { pathname } };
}

(globalThis as { fetch: typeof fetch }).fetch = recordingFetch;

// ── the rail's own composition, mirrored ──────────────────────────────────

/**
 * `loadHost`, in the two shapes it has had.
 *
 * `pathname`: the LOCAL read uses the module-level `createEngineApi()`
 * (app-sidebar.tsx:119, default `pathnameFetcher`) while a REMOTE read pins its
 * host — the asymmetry this file exists to show.
 * `pinned`: every read names its host, including the local one, which is the
 * fix now in `app-sidebar.tsx:403`.
 */
const railApi = createEngineApi(); // ← app-sidebar.tsx:119, verbatim shape
type Composition = "pathname" | "pinned";
let composition: Composition = "pathname";

async function loadHost(host: { id: string; name: string } | undefined) {
  const hostApi =
    composition === "pinned"
      ? createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID))
      : host
        ? createEngineApi(hostFetcher(host.id))
        : railApi;
  const [result, daemonId] = await Promise.all([hostApi.liveSessions(), hostApi.health().then((health) => health.daemonId, () => undefined)]);
  const names = new Map(result.projects.map((entry) => [entry.id, entry.name]));
  const sessions = result.sessions.map((entry) => toSidebarSession(entry, entry.projectId ? names.get(entry.projectId) : undefined, undefined, undefined, host));
  return { sessions, projects: result.projects, ...(daemonId ? { daemonId } : {}) };
}

// ── the trace ─────────────────────────────────────────────────────────────

const findings: string[] = [];
const say = (line: string) => console.log(line);
const rule = (line = "") => say(line ? `\n── ${line} ${"─".repeat(Math.max(0, 66 - line.length))}` : "");

async function railPass(at: string) {
  hops.length = 0;
  standAt(at);
  const book = [{ id: "host_b", name: "mac.lan" }];
  const [local, remote] = await Promise.all([loadHost(undefined), loadHost(book[0]!)]);
  return { local, remote, hops: [...hops] };
}

function describe(rows: readonly SidebarSession[]): string[] {
  return rows.map((row) => `${(row.hostId ?? "«no hostId»").padEnd(12)} ${row.title.padEnd(24)} → ${sessionHref(row)}`);
}

async function main() {
  rule("1. the rail read from a LOCAL address (the case that works)");
  const home = await railPass("/projects/project_9ab0/sessions/session_local1");
  for (const hop of home.hops) say(`  ${hop.pathname.padEnd(46)} reached ${hop.reachedEngine}`);
  say("  rows:");
  for (const line of describe([...home.local.sessions, ...home.remote.sessions])) say(`    ${line}`);

  rule("2. the SAME rail read while standing on remote host_b");
  const away = await railPass("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
  for (const hop of away.hops) say(`  ${hop.pathname.padEnd(46)} reached ${hop.reachedEngine}`);
  const localReadReachedRemote = away.hops.some((hop) => hop.pathname === "/api/hosts/host_b/sessions/live") && !away.hops.some((hop) => hop.pathname === "/api/sessions/live");
  if (localReadReachedRemote) {
    findings.push(
      "The rail's LOCAL read is routed to the remote Mac. `app-sidebar.tsx:119` builds its api with the default `pathnameFetcher`, which resolves the host from the ADDRESS BAR per call (lib/hosts/client.ts:65), and `loadHost(undefined)` uses it (app-sidebar.tsx:403). Standing on /hosts/host_b/*, the read labelled local is answered by host_b.",
    );
  }
  say("  rows:");
  for (const line of describe([...away.local.sessions, ...away.remote.sessions])) say(`    ${line}`);

  const mislabelled = away.local.sessions.filter((row) => row.hostId === undefined && REMOTE_B.sessions.some((entry) => entry.id === row.id && entry.title === row.title));
  if (mislabelled.length > 0) {
    findings.push(
      `${mislabelled.length} of host_b's conversations are stamped as LOCAL rows (no hostId), because \`toSidebarSession\` is called with \`host === undefined\` for that read (app-sidebar.tsx:428-434). They therefore carry no host badge and link to a LOCAL url.`,
    );
  }

  rule("3. following those rows — two outcomes, and the quiet one is worse");
  for (const broken of mislabelled) {
    const href = sessionHref(broken);
    say(`  row  : ${broken.title} (${broken.id})`);
    say(`  href : ${href}   ← no /hosts/ prefix`);
    standAt(href);
    hops.length = 0;
    const answer = await createEngineApi(pathnameFetcher)
      .session(broken.id)
      .then((value) => `200 — opened "${(value as { session: { title: string } }).session.title}"`, (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
    for (const hop of hops) say(`  ${hop.pathname.padEnd(46)} reached ${hop.reachedEngine} → ${hop.status}`);
    say(`  result: ${answer}\n`);
    if (answer.startsWith("not_found")) {
      findings.push(
        `Opening a mislabelled row for an id that exists only on host_b asks THIS Mac for it and gets the engine's own 404 — the "session does not exist" in the screenshots. It is a VALID WRONG-HOST 404, not a transport failure: the request completed, against the wrong engine, which is why the header then falls back to a raw project id and the composer waits for a session that was never going to arrive.`,
      );
    }
    if (answer.startsWith("200")) {
      findings.push(
        `Worse than the 404: when the id exists on BOTH Macs — legal, since ids are minted per engine — the same mislabelled row opens the LOCAL conversation of that id with no error at all. The reader is looking at a different Mac's conversation than the one they clicked, and nothing on screen says so.`,
      );
    }
  }

  rule("4. what the rail's cache keeps");
  let cache: SidebarCache = {};
  cache = rememberRows(cache, LOCAL_HOST_ID, away.local.sessions); // app-sidebar.tsx:475
  cache = rememberRows(cache, "host_b", away.remote.sessions); // app-sidebar.tsx:479
  const remembered = staleRows(cache, LOCAL_HOST_ID);
  for (const line of describe(remembered)) say(`    local cache: ${line}`);
  if (remembered.some((row) => REMOTE_B.sessions.some((entry) => entry.id === row.id && entry.title === row.title))) {
    findings.push(
      "The local slot of the sidebar cache (localStorage `telar-sidebar-cache`) is written with the remote Mac's rows, so the mislabelled rows survive a reload and are shown, dimmed, as this Mac's own whenever the local engine is away.",
    );
  }

  rule("5. dedupe, with both reads in hand");
  const folded = dedupeAcrossHosts([away.local, away.remote]); // app-sidebar.tsx:503
  for (const line of describe(folded)) say(`    ${line}`);
  const keptBroken = folded.some((row) => row.hostId === undefined && REMOTE_B.sessions.some((entry) => entry.id === row.id && entry.title === row.title));
  const droppedGood = !folded.some((row) => row.hostId === "host_b" && row.id === SHARED_SESSION);
  if (keptBroken && droppedGood) {
    findings.push(
      "Both reads carry host_b's daemonId, so `dedupeAcrossHosts` folds them by (daemonId, session id) and the LOCAL read wins by order (session-groups.ts:96-105) — the correctly-stamped `/hosts/host_b/...` row is discarded IN FAVOUR OF the mislabelled one. This is why a row can lose its badge and its host in the same pass.",
    );
  }

  rule("6. remote A → remote B → local → remote B, with a reply held across each move");
  for (const [from, to] of [
    ["/hosts/host_a/projects/project_9ab0/sessions/session_b1", "/hosts/host_b/projects/project_9ab0/sessions/session_b1"],
    ["/hosts/host_b/projects/project_9ab0/sessions/session_b1", "/projects/project_9ab0/sessions/session_local1"],
    ["/projects/project_9ab0/sessions/session_local1", "/hosts/host_b/projects/project_9ab0/sessions/session_b1"],
  ] as const) {
    hops.length = 0;
    holdReplies = true;
    standAt(from);
    // A read begun on `from`, still in flight when the address becomes `to`.
    const inFlight = createEngineApi(pathnameFetcher).session(SHARED_SESSION).then(
      (answer) => `session "${(answer as { session: { title: string } }).session.title}"`,
      (error: { code?: string }) => `refused (${error.code})`,
    );
    standAt(to);
    parked.splice(0).forEach((release) => release());
    holdReplies = false;
    const outcome = await inFlight;
    const hop = hops[0];
    say(`  begun on ${from.padEnd(52)}`);
    say(`  landed while on ${to.padEnd(45)} → reached ${hop?.reachedEngine ?? "?"} → ${outcome}`);
  }
  findings.push(
    "A request's host is decided when its URL is built, not when it resolves, so an in-flight read keeps its original Mac across a navigation. That part is sound: the hazard is a caller that BUILDS a url from the address bar for a subject that is not the address (the rail), or publishes an answer without re-checking its subject.",
  );

  rule("findings, for the pathname-following composition");
  findings.forEach((finding, index) => say(`  ${index + 1}. ${finding}\n`));

  rule("the same pass with every read pinned (the fix)");
  composition = "pinned";
  const pinned = await railPass("/hosts/host_b/projects/project_9ab0/sessions/session_b1");
  for (const hop of pinned.hops) say(`  ${hop.pathname.padEnd(46)} reached ${hop.reachedEngine}`);
  say("  rows:");
  for (const line of describe([...pinned.local.sessions, ...pinned.remote.sessions])) say(`    ${line}`);
  const stillWrong = pinned.local.sessions.filter((row) => row.hostId === undefined && REMOTE_B.sessions.some((entry) => entry.id === row.id && entry.title === row.title));
  say(
    stillWrong.length === 0
      ? "\n  → the local read stays local and no row changes Mac. This is what the\n    rendered-sidebar harness asserts against the real component.\n"
      : `\n  → ${stillWrong.length} rows still mislabelled — the pinned composition is wrong too.\n`,
  );
}

void main();
