/**
 * GLOBAL CONFIGURATION — the Mac-wide defaults a project inherits.
 *
 * Two things are proved here, and the first is the one that matters:
 *
 *   THEY ARE A FALLBACK CHAIN, NOT STORED PREFERENCES. Every case asserts what
 *   `resolveLatex` / `resolveDataScience` actually RESOLVE TO, because a
 *   settings pane whose fields only persisted would be a page of lies. The
 *   order is project → this Mac → Telar's own Tectonic, most specific first,
 *   and a step that names something no longer on disk falls THROUGH rather than
 *   resolving onto a path that is not there.
 *
 *   THEY SURVIVE THE ROUND TRIP. Written over HTTP, validated by the plugin's
 *   own machine schema, read back after a restart.
 *
 * The managed Tectonic is represented here by a real file in the place the
 * installer publishes to — `resolveLatex` asks the filesystem, so a stub would
 * be testing the stub. Nothing downloads: `latex-managed.test.ts` owns the
 * installer itself, with a fetch that never leaves the process.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, latexMachineSettings, dataScienceMachineSettings } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { MANAGED_TECTONIC_VERSION, managedTectonicBinary } from "../src/latex/managed";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-machine-settings-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A project with LaTeX and data science on, and no toolchain of its own. */
async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  return { daemon, client, store: daemon.store };
}

const machine = (daemon: EngineDaemon, plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>) =>
  fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/plugins`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ plugins }),
  });

/** Put a file where the managed installer publishes to, without downloading one. */
function pretendInstalled(daemon: EngineDaemon): string {
  const binary = managedTectonicBinary(daemon.store.paths.root, MANAGED_TECTONIC_VERSION);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(binary, 0o755);
  return binary;
}

// ── the managed Tectonic as a fallback ──────────────────────────────────────

test("with NOTHING chosen and NOTHING installed, LaTeX still does not resolve", async () => {
  // The honest baseline. The managed copy is a fallback, not a fiction: before
  // it is fetched there is no binary, and claiming otherwise would fail at
  // spawn instead of in the settings pane.
  const { store } = await ready();
  expect(store.resolveLatex(store.getSession("session_one"))).toBeUndefined();
});

test("TELAR'S OWN TECTONIC COMPILES A PROJECT THAT CHOSE NOTHING — the point of the whole feature", async () => {
  // A checkout opened on a Mac with no TeX on it. Nobody picked a distribution
  // here and nobody will; it compiles because Telar fetched one.
  const { daemon, store } = await ready();
  const binary = pretendInstalled(daemon);

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ kind: "tectonic", binPath: binary });
});

test("the managed copy is LAST — a Mac default still wins over it", async () => {
  const { daemon, store } = await ready();
  pretendInstalled(daemon);
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" } } } });

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ kind: "texlive", binPath: "/bin/echo" });
});

test("…and a PROJECT's own choice still wins over the Mac's", async () => {
  const { daemon, client, store } = await ready();
  pretendInstalled(daemon);
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" } } } });
  await client.updateProject("project_one", { latex: { enabled: true, toolchain: { kind: "tectonic", path: "/bin/ls" } } });

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ kind: "tectonic", binPath: "/bin/ls" });
});

test("A DEFAULT NAMING SOMETHING THAT IS GONE FALLS THROUGH, it does not resolve onto a dead path", async () => {
  // The difference between "your document compiled" and "latexmk: command not
  // found". A TeX Live that was deleted must not shadow a working install.
  const { daemon, store } = await ready();
  const binary = pretendInstalled(daemon);
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/nowhere/that/exists" } } } });

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ kind: "tectonic", binPath: binary });
});

test("`kind: \"managed\"` names an INTENT and resolves to today's binary", async () => {
  // Stored as a kind rather than as the versioned path, so bumping the pinned
  // Tectonic does not strand every Mac that had chosen it.
  const { daemon, store } = await ready();
  const binary = pretendInstalled(daemon);
  expect((await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "managed" } } } })).status).toBe(200);

  const resolved = store.resolveLatex(store.getSession("session_one"));
  // `tectonic` is what it IS — `planCompile` knows two programs, not three.
  expect(resolved).toMatchObject({ kind: "tectonic", binPath: binary });
});

test("the toolchain answer carries the managed copy, installed or not", async () => {
  const { daemon } = await ready();
  const before = await daemon.store.latexToolchain(true);
  expect(before.managed).toMatchObject({ version: MANAGED_TECTONIC_VERSION, installed: false, installing: false });
  // Supported on whatever this test is running on; the table covers macOS and
  // Linux, which is every platform the engine runs on today.
  expect(before.managed?.supported).toBe(true);

  const binary = pretendInstalled(daemon);
  const after = await daemon.store.latexToolchain(true);
  expect(after.managed).toMatchObject({ installed: true, path: binary });
});

test("the managed status is NOT served from the toolchain's stale cache", async () => {
  // The probe is cached for five seconds because it is a fistful of spawns.
  // Reading the managed field out of that cache would leave a pane showing
  // "not installed" beside a binary that had just landed.
  const { daemon } = await ready();
  await daemon.store.latexToolchain();
  const binary = pretendInstalled(daemon);

  const cached = await daemon.store.latexToolchain();
  expect(cached.managed).toMatchObject({ installed: true, path: binary });
});

// ── the other LaTeX defaults ────────────────────────────────────────────────

test("the DEFAULT ENGINE reaches a resolved compile", async () => {
  const { daemon, store } = await ready();
  await machine(daemon, {
    latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" }, engine: "lualatex" } },
  });

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ engine: "lualatex" });
});

test("a project's own engine beats the Mac's default", async () => {
  const { daemon, client, store } = await ready();
  await machine(daemon, { latex: { enabled: true, settings: { engine: "lualatex" } } });
  await client.updateProject("project_one", {
    latex: { enabled: true, toolchain: { kind: "texlive", path: "/bin/echo", engine: "xelatex" } },
  });

  expect(store.resolveLatex(store.getSession("session_one"))).toMatchObject({ engine: "xelatex" });
});

test("AUTO-INSTALL IS OFF UNLESS ASKED FOR, and reaches the resolved compile when it is", async () => {
  // It runs tlmgr behind a compile, so the default has to be "no".
  const { daemon, store } = await ready();
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" } } } });
  expect(store.resolveLatex(store.getSession("session_one"))?.autoInstallPackages).toBeUndefined();

  await machine(daemon, {
    latex: { enabled: true, settings: { toolchain: { kind: "texlive", path: "/bin/echo" }, autoInstallPackages: true } },
  });
  expect(store.resolveLatex(store.getSession("session_one"))?.autoInstallPackages).toBe(true);
});

// ── data science defaults ───────────────────────────────────────────────────

test("the MAC'S DEFAULT PYTHON runs a project that chose none", async () => {
  const { daemon, client, store } = await ready();
  await client.updateProject("project_one", { dataScience: { enabled: true } });
  expect(store.resolveDataScience(store.getSession("session_one"))).toBeUndefined();

  await machine(daemon, { "data-science": { enabled: true, settings: { python: "/bin/echo" } } });
  expect(store.resolveDataScience(store.getSession("session_one"))).toEqual({ pythonPath: "/bin/echo" });
});

test("a project's own interpreter still wins, and a Mac default that is gone resolves to nothing", async () => {
  const { daemon, client, store } = await ready();
  await machine(daemon, { "data-science": { enabled: true, settings: { python: "/bin/echo" } } });
  await client.updateProject("project_one", {
    dataScience: { enabled: true, python: { source: "chosen", path: "/bin/ls", resolvedAt: Date.now() } },
  });
  expect(store.resolveDataScience(store.getSession("session_one"))).toEqual({ pythonPath: "/bin/ls" });

  await machine(daemon, { "data-science": { enabled: true, settings: { python: "/nowhere/python3" } } });
  await client.updateProject("project_one", { dataScience: { enabled: true } });
  expect(store.resolveDataScience(store.getSession("session_one"))).toBeUndefined();
});

test("the machine ceiling still wins over a machine DEFAULT", async () => {
  // Turning the plugin off for this Mac makes it unavailable even though the
  // very same file holds a perfectly good default. `effective = machine AND
  // project` is not weakened by there being settings beside the switch.
  const { daemon, store } = await ready();
  pretendInstalled(daemon);
  expect(store.resolveLatex(store.getSession("session_one"))).toBeDefined();

  await machine(daemon, { latex: { enabled: false, settings: { toolchain: { kind: "managed" } } } });
  expect(store.resolveLatex(store.getSession("session_one"))).toBeUndefined();
});

// ── the round trip ──────────────────────────────────────────────────────────

test("the new settings ROUND-TRIP: written, read back, and survive a restart", async () => {
  const { daemon } = await ready();
  const latex = { toolchain: { kind: "managed" }, engine: "xelatex", autoInstallPackages: true };
  const ds = { python: "/bin/echo", packages: ["pandas", "matplotlib"] };
  expect((await machine(daemon, { latex: { enabled: true, settings: latex }, "data-science": { enabled: true, settings: ds } })).status).toBe(200);

  const answer = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/plugins`, {
    headers: { authorization: `Bearer ${daemon.discovery.token}` },
  });
  const body = (await answer.json()) as { machine: Parameters<typeof latexMachineSettings>[0] };
  expect(latexMachineSettings(body.machine)).toEqual({ toolchain: { kind: "managed" }, engine: "xelatex", autoInstallPackages: true });
  expect(dataScienceMachineSettings(body.machine)).toEqual({ python: "/bin/echo", packages: ["pandas", "matplotlib"] });

  const home = daemon.store.paths.root;
  await daemon.close();
  daemons.length = 0;
  const restarted = await startEngine({ models: stubModels, engineRoot: home });
  daemons.push(restarted);
  expect(latexMachineSettings(restarted.store.machinePlugins()).engine).toBe("xelatex");
  expect(dataScienceMachineSettings(restarted.store.machinePlugins()).packages).toEqual(["pandas", "matplotlib"]);
});

test("the MACHINE schema validates the machine arm — a project-only field is refused", async () => {
  const { daemon } = await ready();
  // `mainFile` is a fact about a checkout. Before the machine arm had its own
  // schema it reused the project one, so this was silently accepted and stored
  // somewhere nothing would ever read it.
  const bad = await machine(daemon, { latex: { enabled: true, settings: { mainFile: "paper.tex" } } });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(await bad.json())).toContain("not valid for latex");

  // …and so is a nonsense value in a field that IS machine-scoped.
  const worse = await machine(daemon, { latex: { enabled: true, settings: { engine: "troff" } } });
  expect(worse.status).toBe(400);

  const ds = await machine(daemon, { "data-science": { enabled: true, settings: { packages: "pandas" } } });
  expect(ds.status).toBe(400);
});

test("A DEFAULT PACKAGE THAT COULD BE READ AS A FLAG IS REFUSED AT THE WRITE", async () => {
  // The list ends up in argv for uv or conda. Refusing it here is so the person
  // is told while they are looking at the field; `planEnvironment` checks again
  // at creation, because a blob on disk may predate this.
  const { daemon } = await ready();
  expect((await machine(daemon, { "data-science": { enabled: true, settings: { packages: ["--index-url=https://evil.example"] } } })).status).toBe(400);
  expect((await machine(daemon, { "data-science": { enabled: true, settings: { packages: ["polars", "-r reqs.txt"] } } })).status).toBe(400);
  // A pinned requirement is ordinary and must not be caught by the same net.
  expect((await machine(daemon, { "data-science": { enabled: true, settings: { packages: ["polars>=1.0", "httpx[http2]"] } } })).status).toBe(200);
});

test("THE STORE PASSES THIS MAC'S DEFAULTS INTO ENVIRONMENT CREATION", async () => {
  /**
   * The end of the wire, proved through the refusal rather than through the
   * happy path — and deliberately so.
   *
   * A successful plan needs uv on the machine running the test, which is not
   * something a test may assume. The package check runs BEFORE the uv check,
   * so a bad default produces its own message and a good one falls through to
   * "uv is not installed". Getting the first message can only happen if the
   * store actually read this Mac's settings and handed them to
   * `planEnvironment` — which is the wiring under test. `ds-packages.test.ts`
   * owns what the plan then contains.
   *
   * The blob is written to disk rather than over HTTP because the write arm now
   * refuses this, and a value that PREDATES that check is exactly the case the
   * second check exists for.
   *
   * WHAT THIS TEST IS NOT, SINCE #792 READ IT AS THAT. It does not guard the
   * ORDER of the two checks, and cannot: a runner with uv satisfies the uv
   * check either way, so the order leaves no trace here. `ds-packages.test.ts`
   * owns that, with a uv-less toolchain injected — the only arrangement in
   * which the two refusals are distinguishable on any machine.
   *
   * ITS ONE ENVIRONMENTAL DEPENDENCY IS NOT uv EITHER. It is that
   * `dataScienceToolchain` finishes inside the per-test ceiling: this call
   * probes for uv, conda and Homebrew, and a cold GitHub runner can spend
   * seconds in that before the store ever reaches the package check. When #792's
   * CI failure hit it at bun's 5 s default — #740 having left every file but
   * the first on that default — the fixture's temp root was already removed by
   * `afterEach` by the time the probe returned, so the store read no machine
   * defaults at all, found nothing to refuse, and fell through to "uv is not
   * installed". The message was an artefact of the teardown, not evidence about
   * the order, and it is why a duration and a message from a timed-out test are
   * both worth distrusting.
   */
  const { daemon, client } = await ready();
  await client.updateProject("project_one", { dataScience: { enabled: true } });
  fs.writeFileSync(
    daemon.store.paths.machinePlugins,
    JSON.stringify({ version: 1, entries: { "data-science": { enabled: true, settings: { packages: ["--index-url=https://evil.example"] } } } }),
  );
  // The lenient reader keeps it — which is the point: it must reach the check
  // rather than being silently dropped on the way.
  expect(dataScienceMachineSettings(daemon.store.machinePlugins()).packages).toEqual(["--index-url=https://evil.example"]);

  const refused = await daemon.store
    .dataScienceCreateEnvironment("project_one", { manager: "venv", location: "telar", python: "3.13" })
    .then(() => undefined)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  expect(refused).toContain("not a package requirement");
  expect(refused).toContain("Settings › Plugins");
});

test("ONLY `managed` may omit a path — the other kinds name a place", async () => {
  // A `texlive` default with nowhere to be resolves to nothing, which in the
  // pane reads as a setting that saved and then did not work. `managed` is the
  // exception because the ENGINE supplies its place.
  const { daemon } = await ready();
  expect((await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "texlive" } } } })).status).toBe(400);
  expect((await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "tectonic" } } } })).status).toBe(400);
  expect((await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "managed" } } } })).status).toBe(200);
});

test("a machine default is a DEFAULT, and a project turning the plugin off still wins", async () => {
  // The chain starts at the project's switch, not at the Mac's settings: a
  // project that never asked for LaTeX gets none, however configured this Mac is.
  const { daemon, client, store } = await ready();
  pretendInstalled(daemon);
  await machine(daemon, { latex: { enabled: true, settings: { toolchain: { kind: "managed" } } } });
  await client.updateProject("project_one", { latex: null });

  expect(store.resolveLatex(store.getSession("session_one"))).toBeUndefined();
});
