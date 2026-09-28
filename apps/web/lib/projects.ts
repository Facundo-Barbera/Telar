"use client";

/**
 * The project registry, shared by every surface that lists projects.
 *
 * ENGINE STATE, NOT LOCAL STORAGE — same argument as `inbox-policy.ts`, which
 * this module mirrors deliberately: a per-browser copy would show two clients
 * two different registries off one engine.
 *
 * WHY A SHARED HOOK AT ALL. Registering a project used to reach exactly one
 * listener (the rail's `onRegistered`), while the composer greeting's picker,
 * the cockpit breadcrumb and the project-settings header each fetched ONCE on
 * mount and never again — so a fresh project stayed invisible in the picker
 * until a hard reload. The registry changes when a person changes it, in this
 * same app, so a window event carries the change to every mounted listener
 * immediately and nothing needs a poll.
 */

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

