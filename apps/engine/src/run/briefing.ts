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
export const RUN_BRIEFING = [
  "A project with no run configuration can be given one with run_save_config — a name, a command and optionally an icon — so an empty Run menu is something you can set up yourself rather than a missing capability.",
  /**
   * THE SENTENCE THAT REPLACES `sleep 2 && curl`.
   *
   * Every agent that met this feature did the same thing: started a dev server,
   * slept a guess, curled, and reported the connection refusal as the project's
   * bug. `run_wait` is in the toolkit and a model only reads a tool's
   * description once it has decided to look for that tool — and nobody looks
   * for a tool whose job they think `sleep` already does.
   */
  "To wait for a run — a server to start listening, a build to finish — use run_wait, never sleep: it blocks until a pattern matches, the readiness URL answers or the run exits, and tells you WHICH of those happened.",
  /**
   * AND THE ONE ABOUT NOT KILLING THE APP YOU ARE RUNNING IN. Measured, not
   * imagined: `pkill -f next-server` is a plausible-looking way to stop a dev
   * server and it takes Telar's own cockpit down with it — which is why the
   * processes were renamed (`e33f33e2`) and why this says so out loud.
   */
  "To stop a run use run_stop, never pkill or killall: the process named next-server may be another project's dev server, and killing Telar's own processes (now named telar-ui / telar-engine) closes the app.",
].join(" ");
