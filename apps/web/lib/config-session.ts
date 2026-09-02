"use client";

/**
 * THE CONFIG SESSION — a normal Telar session that happens to be pointed at
 * Telar's own settings.
 *
 * WHAT THIS REPLACES. The appearance pane grew a bespoke "designer": its own
 * transcript, its own composer, its own one-shot call to the engine's textgen.
 * It could not search the web, could not see a picture, could not run a
 * command, and every one of those is a thing a real session does already. The
 * fix was not to add them to a private chat; it was to stop having a private
 * chat.
 *
 * WHY IT NEEDED THE FILES FIRST. A session is a CLI subprocess with a working
 * directory. It has no browser, so for as long as themes and looks lived only
 * in localStorage there was nothing on disk for it to edit — it could have
 * written a theme all day and nothing would ever have read it. The appearance
 * home (apps/engine/src/appearance-home.ts) is what makes this session possible
 * rather than decorative.
 *
 * AND A PROJECT IS ONLY A DIRECTORY. The engine asks that a project root be an
 * existing directory and nothing more — no git, no remote — so the state root
 * qualifies, and the whole session machinery (tools, streaming, permissions,
 * questions, the real composer) comes along without a line of new plumbing.
 * That is the point: nothing about the agent is reinvented here.
 */

import { createEngineApi } from "./engine/client";

const api = createEngineApi();

/** The name the project wears in the picker. Also how it is FOUND again — a
 *  second registration of the same root is refused by the engine, so the
 *  lookup has to succeed before the register is attempted. */
export const CONFIG_PROJECT_NAME = "Telar settings";

/**
 * The brief. Written here rather than in a system prompt because it names
 * paths that this build defines, and a prompt maintained somewhere else drifts
 * from them silently — the README in the folder says the same things, and the
 * agent will find that too.
 */
export function configBrief(stateRoot: string): string {
  return [
    "You are configuring Telar itself — this window's own settings — for the person you are talking to.",
    "",
    `Everything lives under ${stateRoot}. The appearance folder has a README describing its layout; read it before writing anything there.`,
    "",
    "    appearance/settings.json      accent, fonts, sizes, translucency, colour scheme",
    "    appearance/themes/<id>.json   a palette: two halves, sixteen tokens each",
    "    appearance/looks/<id>.json    a whole appearance: theme + backdrop + accent + type",
    "    appearance/images/<id>.<ext>  backdrop pictures, referenced by looks",
    "",
    "The app reads these files and merges them into the window on the Appearance pane. Write valid JSON and it appears; a malformed file is skipped and reported rather than breaking anything.",
    "",
    "Other settings the engine owns are JSON beside it — projects.json, mcp-servers.json, provider-instances.json, text-generation.json.",
    "",
    "You have the tools a session has: read and write files, run commands, search the web. If the person asks for a look built from a picture, fetch it, put it in appearance/images/, and reference it from a look.",
  ].join("\n");
}

/**
 * Find the config project, or make it. Returns its id.
 *
 * LOOK BEFORE REGISTERING: the engine refuses a second registration of the
 * same root with a conflict, so "already there" is the common case rather than
 * an error worth surfacing.
 */
export async function ensureConfigProject(stateRoot: string): Promise<string> {
  const existing = await api.projects();
  const found = existing.projects.find((project) => project.root === stateRoot);
  if (found) return found.id;
  const created = await api.registerProject({ name: CONFIG_PROJECT_NAME, root: stateRoot });
  return created.project.id;
}

/** The state root this cockpit's engine is using, straight from /api/about —
 *  the one place that already answers "where does this instance keep things". */
export async function configStateRoot(): Promise<string | undefined> {
  try {
    const about = (await (await fetch("/api/about", { cache: "no-store" })).json()) as { stateRoot?: unknown };
    return typeof about.stateRoot === "string" && about.stateRoot.trim() ? about.stateRoot : undefined;
  } catch {
    return undefined;
  }
}
