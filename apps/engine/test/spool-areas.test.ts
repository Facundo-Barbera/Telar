/**
 * Areas and their permit ceilings — "Personal never gets worked without asking".
 *
 * TWO CLAIMS ARE LOAD-BEARING and both are asserted rather than described: a
 * ceiling clamps DOWN and can never raise a subject's permit, and the clamp
 * actually reaches the enforcement paths — the night's plan gate and the map's
 * reported level — rather than living only in a display.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpoolItem } from "@telar/engine-client";
import { areaPathSegments, areasPath, effectivePermits, effectivePermitsDetail, readAreas, setAreaCeiling } from "../src/spool/areas";
import { ensureSubject, readSubjects, setSubjectIdentity, setSubjectPermits, subjectPermits } from "../src/spool/subjects";
import { subjectThreads } from "../src/spool/threads";
import { planNight } from "../src/spool/night";
import { createItem, ensureSpool, spoolPaths, type SpoolPaths } from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-areas-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

describe("the record", () => {
  test("no area has a record until a ceiling is stated — lazy creation is the only creation", () => {
    // The area exists as a NAME long before any record: identity writes the
    // string onto the subject and mints nothing else.
    ensureSubject(paths, "casa");
    setSubjectIdentity(paths, "casa", { area: "Personal" });
    expect(readAreas(paths)).toEqual([]);
    expect(fs.existsSync(areasPath(paths))).toBe(false);

    const area = setAreaCeiling(paths, "Personal", "read");
    expect(area).toMatchObject({ name: "Personal", ceiling: "read" });
    expect(readAreas(paths)).toHaveLength(1);
  });

  test("clearing withdraws the statement and the record stays — no delete path", () => {
    setAreaCeiling(paths, "Personal", "read");
    const cleared = setAreaCeiling(paths, "Personal", null);
    expect(cleared.ceiling).toBeUndefined();
    // The record sits, unreferenced and harmless, rather than vanishing.
    expect(readAreas(paths).map((a) => a.name)).toEqual(["Personal"]);
  });

  test("a level outside the enum, an empty name and a pasted paragraph each refuse with a sentence", () => {
    expect(() => setAreaCeiling(paths, "Personal", "urgent" as never)).toThrow(/not a permit level/);
    expect(() => setAreaCeiling(paths, "   ", "read")).toThrow(/a word or two/);
    expect(() => setAreaCeiling(paths, "x".repeat(200), "read")).toThrow(/short group name/);
    expect(readAreas(paths)).toEqual([]);
  });

  test("one hand-broken row does not cost the other areas their ceilings", () => {
    setAreaCeiling(paths, "Personal", "read");
    setAreaCeiling(paths, "Trabajo", "draft");
    const rows = JSON.parse(fs.readFileSync(areasPath(paths), "utf8"));
    fs.writeFileSync(areasPath(paths), JSON.stringify([{ ceiling: 7 }, ...rows]));
    expect(readAreas(paths).map((a) => a.name).sort()).toEqual(["Personal", "Trabajo"]);
  });
});

describe("the clamp — effective = min(stated, ceiling), and NEVER a raise", () => {
  const subject = (permits: "read" | "draft" | "propose", area?: string) => ({
    key: "casa",
    name: "casa",
    permits,
    ...(area ? { area } : {}),
    created: "Sat",
    schemaVersion: 1,
  });
  const personal = (ceiling?: "read" | "draft" | "propose") => [
    { name: "Personal", ...(ceiling ? { ceiling } : {}), created: "Sat", schemaVersion: 1 },
  ];

  test("no ceiling = no clamp — the ordinary case, area or not", () => {
    expect(effectivePermits(subject("draft"), [])).toBe("draft");
    expect(effectivePermits(subject("draft", "Personal"), personal())).toBe("draft");
    // An area no record exists for is the same absence.
    expect(effectivePermits(subject("propose", "Personal"), [])).toBe("propose");
  });

  test("a ceiling below the subject's own permit wins", () => {
    expect(effectivePermits(subject("draft", "Personal"), personal("read"))).toBe("read");
    expect(effectivePermits(subject("propose", "Personal"), personal("draft"))).toBe("draft");
  });

  /** THE LAW: a ceiling may never RAISE. A subject at `read` under a `propose`
   *  ceiling stays at `read` — a group statement restricts, it cannot promote. */
  test("a ceiling above the subject's own permit changes nothing", () => {
    expect(effectivePermits(subject("read", "Personal"), personal("propose"))).toBe("read");
    expect(effectivePermits(subject("draft", "Personal"), personal("draft"))).toBe("draft");
  });

  test("an unregistered subject keeps its floor, clamped or not", () => {
    expect(effectivePermits(undefined, personal("read"))).toBe("read");
    expect(effectivePermits(undefined, [])).toBe("read");
  });

  test("the ceiling only reaches subjects that name the area", () => {
    expect(effectivePermits({ ...subject("draft"), key: "ozom-gv", name: "ozom-gv" }, personal("read"))).toBe("draft");
  });
});

describe("areaPathSegments — a canonical path, never a structure", () => {
  test("splits on the canonical separator and trims each segment", () => {
    expect(areaPathSegments("Work / Focaltec")).toEqual(["Work", "Focaltec"]);
    expect(areaPathSegments("Work /  Focaltec  ")).toEqual(["Work", "Focaltec"]);
  });

  test("a name with no separator is one segment", () => {
    expect(areaPathSegments("Personal")).toEqual(["Personal"]);
  });

  test("empty segments drop out rather than throwing", () => {
    expect(areaPathSegments("Work /  / Focaltec")).toEqual(["Work", "Focaltec"]);
    expect(areaPathSegments(" / Work / Focaltec")).toEqual(["Work", "Focaltec"]);
    expect(areaPathSegments("")).toEqual([]);
    expect(areaPathSegments("   ")).toEqual([]);
  });
});

describe("ceilings clamp down the WHOLE path — §13.7, most restrictive wins", () => {
  const subject = (permits: "read" | "draft" | "propose", area?: string) => ({
    key: "casa",
    name: "casa",
    permits,
    ...(area ? { area } : {}),
    created: "Sat",
    schemaVersion: 1,
  });
  const areaRow = (name: string, ceiling?: "read" | "draft" | "propose") => ({
    name,
    ...(ceiling ? { ceiling } : {}),
    created: "Sat",
    schemaVersion: 1,
  });

  test("a ceiling on an ANCESTOR prefix clamps a deeper subject", () => {
    const s = subject("propose", "Work / Focaltec");
    expect(effectivePermits(s, [areaRow("Work", "read")])).toBe("read");
  });

  test("most-restrictive-wins when both the prefix and the exact path carry a ceiling", () => {
    const s = subject("propose", "Work / Focaltec");
    expect(effectivePermits(s, [areaRow("Work", "draft"), areaRow("Work / Focaltec", "read")])).toBe("read");
    // The other order — the exact path is the looser one — still yields the
    // stricter ancestor ceiling.
    expect(effectivePermits(s, [areaRow("Work", "read"), areaRow("Work / Focaltec", "draft")])).toBe("read");
  });

  test("an unrelated prefix that merely SHARES CHARACTERS does not clamp — segment boundary, not string prefix", () => {
    const s = subject("propose", "Work / Focaltec");
    expect(effectivePermits(s, [areaRow("Workshop", "read")])).toBe("propose");
    // Symmetric case: a ceiling on the deeper path must not reach a subject
    // filed at the shallower one.
    const shallow = subject("propose", "Work");
    expect(effectivePermits(shallow, [areaRow("Work / Focaltec", "read")])).toBe("propose");
  });

  test("effectivePermitsDetail names the ACTUAL winning prefix", () => {
    const s = subject("propose", "Work / Focaltec / Q3");
    expect(effectivePermitsDetail(s, [areaRow("Work / Focaltec", "draft")])).toEqual({
      level: "draft",
      clampedBy: "Work / Focaltec",
    });
    // No clamp at all: no `clampedBy` in the result.
    expect(effectivePermitsDetail(s, [])).toEqual({ level: "propose" });
    // A ceiling that cannot beat the subject's own statement (equal or
    // above) never appears as the clamp source either.
    expect(effectivePermitsDetail(s, [areaRow("Work", "propose")])).toEqual({ level: "propose" });
  });

  test("a ceiling above the subject's own permit is never reported as the clamp, even on a losing prefix", () => {
    const s = subject("draft", "Work / Focaltec");
    // "Work" would raise (propose > draft) so it cannot win; "Work / Focaltec"
    // actually restricts, and its name is what the report must carry.
    const result = effectivePermitsDetail(s, [areaRow("Work", "propose"), areaRow("Work / Focaltec", "read")]);
    expect(result).toEqual({ level: "read", clampedBy: "Work / Focaltec" });
  });
});

/**
 * THE ENFORCEMENT SEAMS — the same composition `state.ts` wires, driven against
 * a real store: subjects + areas read off disk, folded through
 * `effectivePermits`, gating the night's plan and reported on the map.
 */
describe("the clamp reaches enforcement", () => {
  const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
    provenance: "typed",
    captured: "Sat 10:00",
    schemaVersion: 1,
    ...over,
  });

  /** Exactly what `subjectGate` composes in `state.ts` — one registry read, one
   *  areas read, the clamp, then the level gate. */
  const gate = () => {
    const subjects = readSubjects(paths);
    const areas = readAreas(paths);
    return (key: string | undefined, level: "read" | "draft") =>
      subjectPermits(
        effectivePermits(
          subjects.find((s) => s.key === key),
          areas,
        ),
        level,
      );
  };

  test("a `read` ceiling over a `draft` subject stops tonight's drafting, and only drafting", () => {
    ensureSubject(paths, "casa"); // defaults to draft
    setSubjectIdentity(paths, "casa", { area: "Personal" });
    const shorthand = item({ id: "i-1", title: "raw", project: "casa", raw: "x" });
    const briefed = item({ id: "i-2", title: "briefed", project: "casa", fixed: "a brief" });

    // Before the statement: today's behaviour, both jobs.
    expect(planNight([shorthand, briefed], gate()).map((j) => j.kind)).toEqual(["ripen", "draft"]);

    setAreaCeiling(paths, "Personal", "read");
    expect(planNight([shorthand, briefed], gate()).map((j) => j.kind)).toEqual(["ripen"]);

    // Withdrawn: the subjects are back to exactly what they state on their own.
    setAreaCeiling(paths, "Personal", null);
    expect(planNight([shorthand, briefed], gate()).map((j) => j.kind)).toEqual(["ripen", "draft"]);
  });

  test("a ceiling above the stated permit raises nothing in the plan", () => {
    ensureSubject(paths, "casa", { permits: "read" });
    setSubjectIdentity(paths, "casa", { area: "Personal" });
    setAreaCeiling(paths, "Personal", "propose");
    const briefed = item({ id: "i-2", title: "briefed", project: "casa", fixed: "a brief" });
    // `read` stays `read`: nothing is drafted because a ceiling cannot promote.
    expect(planNight([briefed], gate())).toEqual([]);
  });

  test("the map reports the EFFECTIVE level — the display cannot promise what the night refuses", () => {
    ensureSubject(paths, "casa");
    setSubjectIdentity(paths, "casa", { area: "Personal" });
    createItem(paths, { title: "arreglar la caldera", provenance: "typed", project: "casa" });

    expect(subjectThreads(paths, "casa").permits).toBe("draft");
    setAreaCeiling(paths, "Personal", "read");
    expect(subjectThreads(paths, "casa").permits).toBe("read");
    // The STATED level survives on the record itself — effective vs stated stay
    // both readable, which is what lets a surface draw the clamp honestly.
    expect(readSubjects(paths).find((s) => s.key === "casa")!.permits).toBe("draft");
  });
});
