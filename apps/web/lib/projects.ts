"use client";

// The registry is engine state, never local storage, so every client sees one list.

/** Same-window propagation. The event carries no payload on purpose: the
 *  registry is the engine's, so every listener re-reads the engine's own
 *  answer rather than trusting whatever a writer happened to hold. */
export const PROJECTS_CHANGED_EVENT = "telar:projects";
const CHANGED = PROJECTS_CHANGED_EVENT;

/** Say the registry changed. Callers that just registered a project call this
 *  AFTER the engine accepted it — see `project-palette.tsx`. */
export function announceProjectsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

