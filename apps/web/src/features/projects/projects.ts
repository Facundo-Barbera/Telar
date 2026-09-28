"use client";

export const PROJECTS_CHANGED_EVENT = "telar:projects";
const CHANGED = PROJECTS_CHANGED_EVENT;

export function announceProjectsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

