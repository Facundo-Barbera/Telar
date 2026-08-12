// THE TRACK E PROVE-RUN — SPEC-organization-workspace's CAP-12, executed.
//
// WHAT THIS IS. The SPEC's success signal is not "each function has a unit
// test"; it is ONE SCRIPTED RUN, in ONE process, under ONE sandboxed state root,
// in which the workspace store is born, serves both kinds of item through one
// shape, survives a torn write, migrates an older packet without destroying the
// user's own words, and is provably owned by exactly one module — with the real
// ~/.telar untouched throughout. Stories 5.2, 5.3, 5.4 and 5.5 all build on this
// store, so this file is a GATE, not a convenience.
//
// The whole run is one command, from the repo root:
//
//     TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-e prove-run"
//
// WHY THE `packages/core` PATH ARGUMENT IS THERE, because it looks redundant
// and is not — the reason is track-a-prove-run.test.ts's, measured there and
// unchanged: apps/web suites install a PROCESS-GLOBAL mock.module("@telar/core",
// …) at MODULE SCOPE and restore it only in afterAll. A repo-root run WITH a -t
// filter evaluates every file's module scope before running any test, so those
// afterAll hooks never fire and the stub is live inside every core suite in the
// process. The path argument keeps the run inside this workspace. (Bun also
// IGNORES a second positional, so `bun test packages/core ./does-not-exist.ts`
// silently runs everything — read a passing filtered run carefully.)
//
// THE SUITE PINS ITS OWN mkdtemp ROOT REGARDLESS. The TELAR_HOME on that command
// line is belt-and-braces, and the pin is what makes the run safe when somebody
// forgets it. It is re-pinned in beforeEach because bun runs every file in ONE
// process and a sibling suite can move the variable.
//
// WHAT THIS DELIBERATELY DOES NOT PROVE, said out loud rather than implied: it
// does not mount the MCP server, does not run a model, and therefore proves
// nothing about the tool pill rendering, an agent CHOOSING to call a tool, or
// the rendered slice. The server's own behaviour is apps/web/lib/
// workspace-mcp.test.ts's; the model's participation is not observable in this
// checkout at all (the @anthropic-ai native sibling is unlinked — see the
// story's Debug Log). A prove-run that implied otherwise would be an over-claim.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "telar-track-e-prove-run-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = HOME;

beforeEach(() => {
  process.env.TELAR_HOME = HOME;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const {
  attachmentTally,
  createItem,
  ensureWorkspace,
  getWorkspaceItem,
  listItems,
  queueSlice,
  rankOf,
  readLanes,
  readPacketAttachments,
  workspaceDir,
  workspaceHomeDir,
  writeLanes,
} = await import("../src/workspace/store");
const { ITEM_SCHEMA_VERSION } = await import("../src/workspace/schema");
type WorkspaceLane = import("../src/workspace/schema").WorkspaceLane;

const lanesPath = () => path.join(HOME, "workspace", "lanes.yaml");
const packetDirOf = (id: string) => path.join(HOME, "workspace", "packets", id);
const packetPath = (id: string) => path.join(packetDirOf(id), "packet.yaml");
const hashOf = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const lane = (key: string, items: string[] = []): WorkspaceLane => ({
  key,
  label: key.toUpperCase(),
  window: "whenever",
  items,
});

describe("track-e prove-run", () => {
  test("L1 the store is born — home/ exists and holds nothing, one lane is seeded, an empty read does not throw", () => {
    // A read BEFORE anything is written. loadManifest is this repo's one
    // deliberate throw-on-absent and is explicitly not the model here: a
    // workspace nobody has used yet is the ordinary first-run state.
    expect(fs.existsSync(path.join(HOME, "workspace"))).toBe(false);
    expect(readLanes()).toEqual([]);
    expect(listItems()).toEqual({ items: [], unreadable: [] });
    expect(getWorkspaceItem("i-nothing")).toBeNull();

    ensureWorkspace();

    expect(workspaceDir()).toBe(path.join(HOME, "workspace"));
    expect(fs.existsSync(lanesPath())).toBe(true);
    // AD-9 / SPEC.md — the master's cwd is dedicated and EMPTY, which is what
    // makes "the store above it stays outside the master's path-based write
    // boundary" structurally true rather than merely intended.
    expect(fs.existsSync(workspaceHomeDir())).toBe(true);
    expect(fs.readdirSync(workspaceHomeDir())).toEqual([]);

    // Exactly ONE seed lane, written by the STORE's ensure step and not by any
    // tool — that distinction is the whole of what makes it legal under
    // NFR-OW-10, which reserves lane structure to the human.
    const lanes = readLanes();
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.key).toBe("unfiled");
  });

  test("L2 one shape, two items — a bare one-liner and a ripened packet through the same writer and reader", () => {
    ensureWorkspace();
    writeLanes([lane("aurora"), lane("unfiled")]);

    const bare = createItem({ title: "call María — invoice", lane: "aurora" });
    const ripe = createItem({
      title: "Rework onboarding flow",
      project: "aurora",
      lane: "aurora",
      raw: "onboarding feels clunky?? ask diego — maybe merge steps 2/3",
      rawSource: "Telar Note · Tue 16:42",
    });

    // ONE reader for both. There is no "rich item" code path to take.
    const readBare = getWorkspaceItem(bare.id)!;
    const readRipe = getWorkspaceItem(ripe.id)!;
    expect(readBare.title).toBe("call María — invoice");
    expect(readRipe.raw).toBe("onboarding feels clunky?? ask diego — maybe merge steps 2/3");

    // The bare one has no tally and no attachments — and needed no migration to
    // be able to grow some.
    expect(readPacketAttachments(bare.id)).toEqual([]);
    expect(attachmentTally(readPacketAttachments(bare.id))).toEqual({ files: 0, mockups: 0 });
    // Both carry a version, because there is only one shape to version.
    expect(readBare.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
    expect(readRipe.schemaVersion).toBe(ITEM_SCHEMA_VERSION);

    // Both are on the desk and both are filed, 1-based, in stack order.
    expect(rankOf(readLanes(), bare.id)).toBe(1);
    expect(rankOf(readLanes(), ripe.id)).toBe(2);
  });

  test("L3 the reconcile rule survives a torn write — all four arms, each read twice", () => {
    ensureWorkspace();
    writeLanes([lane("office"), lane("free")]);

    // ARM 1 — ORPHAN, and THIS IS ALSO THE WRITE-ORDER PROOF. A packet written
    // with lanes.yaml never updated is exactly the crash gap between the two
    // writes; it can only be adopted because the PACKET goes first. Written the
    // other way round, the gap would leave lanes.yaml naming an item whose words
    // were never saved.
    fs.mkdirSync(packetDirOf("i-orphan"), { recursive: true });
    fs.writeFileSync(
      packetPath("i-orphan"),
      YAML.stringify({
        id: "i-orphan",
        title: "written, then the process died",
        provenance: "note",
        captured: "Tue 16:42",
        schemaVersion: ITEM_SCHEMA_VERSION,
        lane: "office",
      }),
    );

    // ARM 2 — TOMBSTONE: a stack id with no packet at all.
    // ARM 3 — LANE GONE: a packet pointing at a lane that is not in lanes.yaml.
    fs.mkdirSync(packetDirOf("i-homeless"), { recursive: true });
    fs.writeFileSync(
      packetPath("i-homeless"),
      YAML.stringify({
        id: "i-homeless",
        title: "its lane was retired",
        provenance: "note",
        captured: "Tue 16:43",
        schemaVersion: ITEM_SCHEMA_VERSION,
        lane: "a-lane-the-user-retired",
      }),
    );
    // ARM 4 — DUPLICATE: the same id pasted into two stacks by hand.
    const filed = createItem({ title: "an ordinary filed item", lane: "office" });
    writeLanes([lane("office", [filed.id, "i-ghost"]), lane("free", [filed.id])]);

    // Read TWICE and assert nothing changed — idempotence, which is what makes
    // reconcile-on-read safe to re-enter after a crash mid-sequence (AD-15).
    const read = () => queueSlice(readLanes(), listItems().items).map((r) => `${r.lane}:${r.rank}:${r.item.id}`);
    const first = read();
    const second = read();
    expect(second).toEqual(first);

    expect(first).toEqual([
      `office:1:${filed.id}`, // the ordinary case
      "office:2:i-orphan", // arm 1 — adopted into the stack its packet names
      // arm 2 — "i-ghost" has no packet and is simply absent
      // arm 3 — "i-homeless" is UNFILED and gets no row
      // arm 4 — the second occurrence of `filed` in "free" lost to the first
    ]);

    // Arm 2 and arm 4 are REPORTED rather than silently dropped.
    const { unreadable } = listItems();
    expect(unreadable.some((u) => u.id === "i-ghost")).toBe(true);
    expect(unreadable.some((u) => u.id === filed.id && u.reason.includes("more than one lane"))).toBe(true);

    // Arm 3 — unfiled is a RESTING STATE: still listed, never in the queue,
    // rank null. Dropping it would be a silent deletion; throwing would break
    // the never-throw contract; creating its lane would violate NFR-OW-10.
    expect(listItems().items.map((i) => i.id)).toContain("i-homeless");
    expect(rankOf(readLanes(), "i-homeless")).toBeNull();

    // PROJECTION-ONLY, and this is the load-bearing half: reconciliation NEVER
    // writes back, so the tombstone's id is still in lanes.yaml. Otherwise one
    // transiently unreadable packet directory would be permanently dropped by
    // the next write — a deletion path that never calls rmSync.
    expect(readLanes().find((l) => l.key === "office")!.items).toContain("i-ghost");
  });

  test("L4 migration in the direction that matters — an older packet migrates and the user's own words survive", () => {
    ensureWorkspace();
    const id = "i-oldshape";
    fs.mkdirSync(packetDirOf(id), { recursive: true });
    fs.writeFileSync(
      packetPath(id),
      YAML.stringify({
        id,
        title: "Rework onboarding flow",
        provenance: "pasted transcript",
        captured: "Tue 16:42",
        // LOWER than this build's version, so the read genuinely migrates.
        schemaVersion: 0,
        lane: "unfiled",
        raw: "onboarding feels clunky?? ask diego — maybe merge steps 2/3",
        rawSource: "Telar Note · Tue 16:42",
        // The design-source fixtures' sub-task shape: {title, done?}, NO id.
        subtasks: [{ title: "merge steps 2 and 3" }, { title: "keep invites untouched", done: true }],
        // A field written by a NEWER Telar that this build has never heard of.
        aFieldFromTheFuture: { nested: ["shape", 1] },
      }),
    );
    const before = hashOf(packetPath(id));

    const item = getWorkspaceItem(id)! as Record<string, unknown>;

    // IT MIGRATED…
    expect(item.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
    const subtasks = item.subtasks as Array<Record<string, unknown>>;
    for (const st of subtasks) expect(typeof st.id).toBe("string");
    expect(new Set(subtasks.map((s) => s.id)).size).toBe(2);

    // …`raw` AND `rawSource` ARE BYTE-IDENTICAL. This is the property the whole
    // version field exists to protect: item-model.md calls keeping `raw` beside
    // `fixed` load-bearing, because it is what lets the user check the expert did
    // not drift from what they meant.
    expect(item.raw).toBe("onboarding feels clunky?? ask diego — maybe merge steps 2/3");
    expect(item.rawSource).toBe("Telar Note · Tue 16:42");

    // …THE UNKNOWN KEY SURVIVED (z.looseObject; a plain z.object would have
    // stripped it, and the next write would have destroyed it silently)…
    expect(item.aFieldFromTheFuture).toEqual({ nested: ["shape", 1] });

    // …AND THE READ WROTE NOTHING BACK. A read that writes is precisely the
    // hazard INV-7 exists to police. Content hash, not mtime: macOS mtime
    // resolution is coarse enough that a rewrite inside one tick would pass an
    // mtime check.
    expect(hashOf(packetPath(id))).toBe(before);

    // A packet from a NEWER Telar is refused rather than guessed at, and the
    // file is left exactly as it is.
    const ahead = "i-fromthefuture";
    fs.mkdirSync(packetDirOf(ahead), { recursive: true });
    fs.writeFileSync(
      packetPath(ahead),
      YAML.stringify({
        id: ahead,
        title: "written by a newer telar",
        provenance: "note",
        captured: "Tue 16:44",
        schemaVersion: ITEM_SCHEMA_VERSION + 1,
        raw: "words with no source to be rebuilt from",
      }),
    );
    const aheadHash = hashOf(packetPath(ahead));
    expect(getWorkspaceItem(ahead)).toBeNull(); // never a throw out of the reader…
    expect(listItems().unreadable.some((u) => u.id === ahead && /AD-7/.test(u.reason))).toBe(true);
    expect(hashOf(packetPath(ahead))).toBe(aheadHash); // …and never a rewrite
  });

  test("L5 the subtree has ONE owner, and the real telar home is untouched throughout", () => {
    // Declared last so it runs last — bun runs a file's tests in declaration
    // order — which is what makes "throughout" mean the whole run rather than
    // one moment in it.
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.TELAR_HOME).toBe(HOME);

    // ── the one-owner claim, re-derived here rather than cited ──
    // EVERY LITERAL THIS LEG QUOTES IS BUILT FROM FRAGMENTS. packages/core/test
    // is one of invariants.test.ts's walked roots, so a quoted
    // `path.join(telarDir(), "workspace")` in this file would report the
    // PROVE-RUN ITSELF as a second composing site and turn INV-3a red. INV-3g
    // does the same thing for the same reason.
    const REPO = path.resolve(import.meta.dir, "..", "..", "..");
    const joinCall = "path." + "join";
    const rootFn = "telar" + "Dir";
    const subtree = "work" + "space";
    const needle = `${joinCall}(${rootFn}(), "${subtree}")`;

    // `apps/web/lib` and `apps/web/app` were dropped when the legacy cockpit was
    // frozen and renamed to apps/web_old. They are NOT re-pointed at the new
    // path deliberately: the claim this leg proves is "exactly one module in the
    // LIVE tree composes the workspace root", and a frozen tree cannot acquire a
    // second composing site. The walk() below already swallows a missing
    // directory silently, so leaving stale roots here would have degraded this
    // scan into a narrower one without saying so. The anti-vacuity check below
    // is what keeps the remaining roots honest.
    const roots = ["packages/core/src", "apps/vnext-web/lib", "apps/vnext-web/app", "scripts"];
    const composing: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".next")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        if (fs.readFileSync(abs, "utf8").includes(needle)) {
          composing.push(path.relative(REPO, abs).split(path.sep).join("/"));
        }
      }
    };
    for (const r of roots) walk(path.join(REPO, r));

    // ANTI-VACUITY: the walk really visited files, so "exactly one composes it"
    // is a claim about a scanned tree rather than about an empty list.
    expect(fs.existsSync(path.join(REPO, "packages/core/src"))).toBe(true);
    expect(composing).toEqual(["packages/core/src/workspace/store.ts"]);

    // ── the real ~/.telar is untouched ──
    // Everything this run wrote went under the mkdtemp root, and the store's own
    // subtree is the only thing in it.
    expect(fs.existsSync(path.join(HOME, "workspace", "lanes.yaml"))).toBe(true);
    const real = path.join(os.homedir(), ".telar");
    expect(HOME.startsWith(os.homedir() + path.sep + ".telar")).toBe(false);
    expect(workspaceDir().startsWith(HOME)).toBe(true);
    expect(workspaceDir().startsWith(real)).toBe(false);
  });
});
