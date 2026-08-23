/**
 * THE APERTURE SLOT — which smart view the wide room is showing.
 *
 * ── ONE CURRENT VALUE, AND DELIBERATELY NOT A LOG ────────────────────────────
 * The focus store is a LOG because focus narrates WORK: "Saturday you were on
 * ozom-gv" is a fact about your attention that the pickup reads back to you.
 * A glance is not work. Recording every switch between Today, Scheduled and
 * everything would teach the pickup to narrate looking-around as if it were a
 * day's activity — "Tuesday you were on Scheduled" is not a sentence anyone
 * should ever be shown. So this file holds exactly one value, overwritten in
 * place, with no history and nothing for any reading to fold in.
 *
 * SUBJECT FOCUS IS A DEEPER APERTURE AND STAYS IN THE FOCUS STORE. This slot
 * only ever holds the smart view (`docs/spool-loops.md` §8's Today/Scheduled
 * beside the ordinary wide room); it cannot name a subject.
 *
 * ONE WRITER NOW: THE HAND'S OWN CLICK. `spool_set_aperture` used to write
 * here too — removed from every tool wall under docs/spool-loops.md §13.6,
 * "the room has belonged to the user's own hand since the re-entry rebuild."
 * This file and its route are UNCHANGED and still live: the hand's click
 * still lands here, idempotent, exactly as before. Only the second writer is
 * gone.
 */
import fs from "node:fs";
import path from "node:path";
import { SpoolAperture, SpoolApertureView } from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import type { SpoolPaths } from "./store";

const APERTURE_FILE = "aperture.json";

export function aperturePath(paths: SpoolPaths): string {
  return path.join(paths.root, APERTURE_FILE);
}

/** Never written — or unreadable — is the ordinary wide room, not an error. */
export function readAperture(paths: SpoolPaths): SpoolAperture {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(aperturePath(paths), "utf8"));
  } catch {
    return { view: "everything", schemaVersion: 1 };
  }
  const parsed = SpoolAperture.safeParse(raw);
  return parsed.success ? parsed.data : { view: "everything", schemaVersion: 1 };
}

/**
 * Point the room at a view. THROWS A SENTENCE on a view outside the closed
 * set — a write is loud, like every other write-side guard in this store.
 */
export function setAperture(paths: SpoolPaths, view: unknown): SpoolAperture {
  const parsed = SpoolApertureView.safeParse(view);
  if (!parsed.success) {
    throw new Error(
      `"${String(view)}" is not a view the room has. The aperture is one of ${SpoolApertureView.options
        .map((v) => `"${v}"`)
        .join(", ")} — the whole room, today's glance, or everything pinned to a day.`,
    );
  }
  const next: SpoolAperture = { view: parsed.data, schemaVersion: 1 };
  atomicWrite(aperturePath(paths), next);
  return next;
}
