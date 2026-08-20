/**
 * The aperture slot — one current value, and DELIBERATELY not a log.
 *
 * The focus store is a log because focus narrates work. A glance is not work:
 * recording every switch between Today, Scheduled and everything would teach
 * the pickup to narrate looking-around as a day's activity. So the load-bearing
 * assertions here are the ABSENCES — no history accumulates, and no reading
 * exists for anything to fold a history into.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aperturePath, readAperture, setAperture } from "../src/spool/aperture";
import { ensureSpool, spoolPaths, type SpoolPaths } from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-aperture-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

describe("the slot", () => {
  test("never written is the ordinary wide room, not an error", () => {
    expect(readAperture(paths)).toEqual({ view: "everything", schemaVersion: 1 });
    // And the read minted no file — a glance that never happened writes nothing.
    expect(fs.existsSync(aperturePath(paths))).toBe(false);
  });

  test("set, read back, overwrite — last writer wins and setting twice is one statement", () => {
    expect(setAperture(paths, "today").view).toBe("today");
    expect(readAperture(paths).view).toBe("today");

    // Idempotent: the same view again is the same slot, not a second record.
    setAperture(paths, "today");
    setAperture(paths, "scheduled");
    expect(readAperture(paths).view).toBe("scheduled");
  });

  /**
   * THE DELIBERATE ABSENCE: no history. The file holds ONE object, however many
   * times the view changed — a log of glances would be the focus store's shape,
   * and the focus LOG narrates work; a glance is not work.
   */
  test("NO history — a day of switching leaves one value on disk, not a log", () => {
    for (const view of ["today", "scheduled", "everything", "today", "scheduled"] as const) {
      setAperture(paths, view);
    }
    const raw = JSON.parse(fs.readFileSync(aperturePath(paths), "utf8"));
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toEqual({ view: "scheduled", schemaVersion: 1 });
  });

  test("a view outside the closed set refuses with a sentence, and nothing is written", () => {
    setAperture(paths, "today");
    expect(() => setAperture(paths, "urgent")).toThrow(/not a view the room has/);
    expect(() => setAperture(paths, undefined)).toThrow(/"everything", "today", "scheduled"/);
    expect(readAperture(paths).view).toBe("today");
  });

  test("a hand-mangled file degrades to the wide room rather than throwing", () => {
    fs.writeFileSync(aperturePath(paths), "{ not json");
    expect(readAperture(paths)).toEqual({ view: "everything", schemaVersion: 1 });
    fs.writeFileSync(aperturePath(paths), JSON.stringify({ view: "urgent" }));
    expect(readAperture(paths).view).toBe("everything");
  });
});
