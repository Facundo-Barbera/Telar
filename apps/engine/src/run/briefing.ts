/**
 * The one sentence that introduces the run wall to the model.
 *
 * WHY A SENTENCE AND NOT A TOOL DESCRIPTION. `run_save_config` already says
 * what it does, but a model only reads a tool's description once it has decided
 * to look for that tool — and "this project has no Run menu" reads as a missing
 * capability rather than as an empty one it may fill. Saying it in the system
 * context is what makes setting the menu up an option the model considers
 * without being asked twice.
 *
 * Injected only when the session actually has the run capability, exactly as
 * `BROWSER_BRIEFING` is injected only when it has a browser: a project-less
 * session told it can save a run configuration would be told a lie it acts on.
 */
export const RUN_BRIEFING =
  "A project with no run configuration can be given one with run_save_config — a name, a command and optionally an icon — so an empty Run menu is something you can set up yourself rather than a missing capability.";
