/**
 * The `run_*` wall: saved launches and the project's one local deployment.
 *
 * THE AGENT GETS THE SAME RULES AS THE BUTTON, and the reason is not symmetry.
 * A model asked to "start the dev server" will try twice if the first answer is
 * ambiguous, and it will try from whichever conversation it happens to be in —
 * so the singleton, the worktree capture and the deliberate-takeover rule all
 * live under this wall in the manager rather than in the sentence a skill wrote.
 * A tool here cannot start a second deployment even if it wants to.
 *
 * A REFUSAL NAMES THE WAY OUT. `run_start` against a live deployment answers
 * with what is running, from which tree, and the two verbs that resolve it
 * (`run_stop`, or `run_start` with `replace`), because a model that gets only
 * "conflict" will retry the identical call.
 */
import { z } from "zod";
import { err, failure, json, ok, type ToolFactory } from "../tool-kit";
import type { RunCapability } from "./capability";
import { RunIcon, RunShell, type RunView } from "./types";

/** Tools that only read. Handed to the host, which decides the approval posture. */
export const RUN_READ_ONLY_TOOLS = ["run_configs", "run_status", "run_output"] as const;

function describe(run: RunView): string {
  const where = run.worktreeBranch ? `${run.worktreePath} (${run.worktreeBranch})` : run.worktreePath;
  const readiness =
    run.readiness.kind === "ready"
      ? ` — ${run.readinessUrl} is answering`
      : run.readiness.kind === "pending"
        ? ` — waiting for ${run.readinessUrl}`
        : run.readiness.kind === "unattributable"
          ? ` — readiness cannot be attributed to this process (${run.readiness.reason})`
          : "";
  const ended = run.endedAt ? ` exit ${run.exitCode ?? run.signal ?? "?"}.` : "";
  // WHERE IT ALREADY IS, so an answer can point rather than describe: since
  // #890 a live run is a shell in the cockpit's Terminal strip, and the id is
  // the only name for it that both halves agree on.
  const surface = run.terminalId ? ` Its terminal is ${run.terminalId} — the human sees it as a chip in the Terminal tab.` : "";
  return `"${run.configName}" is ${run.status} (run ${run.runId}) from ${where}, cwd ${run.cwd}.${readiness}${ended}${run.error ? ` ${run.error}` : ""}${surface}`;
}

export function runTools(tool: ToolFactory, capability: RunCapability): unknown[] {
  return [
    tool(
      "run_configs",
      "The project's saved run configurations — name, icon, command, working directory and which environment variables are set. Secret values are never returned. Read this before starting anything: a project usually already has the recipe you want, and if it has none you can give it one with run_save_config.",
      {},
      async () => {
        try {
          const configs = await capability.configurations();
          if (!configs.length) return ok("This project has no saved run configurations yet. Create one with run_save_config.");
          return json(configs);
        } catch (error) {
          return err(`Could not read the run configurations: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_save_config",
      "Save a run configuration on the PROJECT (it outlives this conversation), or edit one by passing its configId. This is how a project with an empty Run menu gets one — you can set the menu up yourself, no human step in between. The working directory is relative to whichever worktree the run is launched from — never an absolute path. Give a readinessUrl only if the command really serves it; without one a run never claims to be ready.",
      {
        configId: z.string().min(1).optional().describe("Edit this configuration instead of creating one."),
        name: z.string().min(1).max(120).optional().describe("What a human picks in the Run menu, e.g. 'web dev'."),
        icon: RunIcon.optional().describe("The glyph the Run menu draws before the name. Default: 'play'."),
        command: z.string().min(1).optional().describe("The shell command, e.g. 'bun run dev'."),
        shell: RunShell.optional().describe(
          "Which program evaluates the command, spelled out: it is spawned with args followed by the command, e.g. {program:'/bin/bash', args:['-lc']}. Leave it out unless the recipe genuinely needs a particular shell — an absent one is resolved against whatever platform the run launches on, which is what keeps a recipe openable on another machine.",
        ),
        cwd: z.string().optional().describe("Directory relative to the worktree root, e.g. 'apps/web'. Default: the root."),
        env: z
          .array(z.object({ key: z.string().min(1), value: z.string(), secret: z.boolean().optional() }))
          .optional()
          .describe("Environment variables. Mark a value secret to keep it out of every read and out of captured output."),
        readinessUrl: z.string().url().optional().describe("A URL that answers once the service is up, e.g. 'http://localhost:3000'."),
      },
      async (args) => {
        const patch = {
          ...(typeof args.name === "string" ? { name: args.name } : {}),
          // Parsed rather than cast: the tool schema is the model's contract,
          // but a name outside the closed set must be refused here too, or a
          // configuration would be stored with an icon nothing can draw.
          ...(RunIcon.safeParse(args.icon).success ? { icon: args.icon as RunIcon } : {}),
          ...(typeof args.command === "string" ? { command: args.command } : {}),
          // Parsed, not cast, for the same reason as the icon: a malformed
          // shell must be refused here rather than stored and spawned.
          ...(RunShell.safeParse(args.shell).success ? { shell: RunShell.parse(args.shell) } : {}),
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(Array.isArray(args.env) ? { env: args.env as { key: string; value: string; secret?: boolean }[] } : {}),
          ...(typeof args.readinessUrl === "string" ? { readinessUrl: args.readinessUrl } : {}),
        };
        try {
          if (typeof args.configId === "string") {
            const updated = await capability.updateConfiguration(args.configId, patch);
            return ok(`Updated "${updated.name}" (${updated.id}): ${updated.command}`);
          }
          if (!patch.name || !patch.command) return err("A new run configuration needs at least a name and a command.");
          const created = await capability.createConfiguration({ name: patch.name, command: patch.command, ...patch });
          return ok(`Saved "${created.name}" (${created.id}): ${created.command}${created.cwd ? ` in ${created.cwd}` : ""}.`);
        } catch (error) {
          return err(`Could not save that run configuration: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_delete_config",
      "Forget a saved run configuration. It does not stop anything: a run already launched from it keeps its own copy of the command and keeps running.",
      { configId: z.string().min(1).describe("The configuration to remove.") },
      async (args) => {
        try {
          await capability.removeConfiguration(String(args.configId));
          return ok("Removed that run configuration.");
        } catch (error) {
          return err(`Could not remove that run configuration: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_status",
      "What is deployed for this project right now — the live run with the worktree it was launched from, plus recent finished runs. A project has ONE local deployment, shared by every conversation, so this is the same answer another session would get. Call it before starting or stopping anything.",
      {},
      async () => {
        try {
          const status = await capability.status();
          if (!status.active) {
            const recent = status.history[0];
            return ok(
              `Nothing is deployed for this project.${recent ? ` Last run: ${describe(recent)}` : ""}${
                status.sessionWorktreePath ? `\nThis session's worktree: ${status.sessionWorktreePath}` : ""
              }`,
            );
          }
          const mismatch =
            status.sessionWorktreePath && status.sessionWorktreePath !== status.active.worktreePath
              ? `\nNOTE: this session works in ${status.sessionWorktreePath}, which is NOT the tree that run was launched from. Starting with replace:true would take the deployment over — do that only if the human asked for it.`
              : "";
          return ok(`${describe(status.active)}${mismatch}`);
        } catch (error) {
          return err(`Could not read the run status: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_start",
      "Launch a saved configuration on this session's worktree. A project has ONE local deployment: if something is already running this refuses and tells you what — pass replace:true ONLY when the human has asked to take the deployment over, since another conversation may be watching it.",
      {
        configId: z.string().min(1).describe("Which saved configuration to launch (see run_configs)."),
        replace: z.boolean().optional().describe("Stop the project's current deployment and take its place. A deliberate takeover, not a retry."),
      },
      async (args) => {
        try {
          const run = await capability.start({
            configId: String(args.configId),
            ...(args.replace === true ? { replace: true } : {}),
          });
          return ok(`Started ${describe(run)}\nUse run_output to read what it prints.`);
        } catch (error) {
          // The manager's message serves the panel too, so it names the choice
          // without naming tools. Spell the verbs out here: a model given only
          // "already running" retries the identical call.
          const ways = args.replace === true ? "" : "\nEither run_stop it first, or call run_start again with replace:true if the human asked to take it over.";
          return err(`Did not start: ${failure(error)}${ways}`);
        }
      },
    ),

    tool(
      "run_stop",
      "Stop the project's deployment — the whole process group, so watchers and child servers go too. Defaults to the live run.",
      { runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now.") },
      async (args) => {
        try {
          const run = await capability.stop(typeof args.runId === "string" ? { runId: args.runId } : {});
          return ok(`Stopped ${describe(run)}`);
        } catch (error) {
          return err(`Did not stop: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_restart",
      "Stop and start the same configuration on the same worktree, holding the project's deployment slot across the gap so nothing else can slip in.",
      { runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now.") },
      async (args) => {
        try {
          const run = await capability.restart(typeof args.runId === "string" ? { runId: args.runId } : {});
          return ok(`Restarted ${describe(run)}`);
        } catch (error) {
          return err(`Did not restart: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_output",
      "Captured stdout and stderr for a run, including after it exited. Output is a bounded window — the oldest lines are dropped under load and the count of dropped lines is reported. Pass the cursor from a previous call to read only what is new.",
      {
        runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now."),
        after: z.number().int().min(0).optional().describe("A cursor from an earlier call; only newer lines come back."),
      },
      async (args) => {
        try {
          const result = await capability.output({
            ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
            ...(typeof args.after === "number" ? { after: args.after } : {}),
          });
          const body = result.lines.map((line) => (line.stream === "stderr" ? `! ${line.text}` : line.text)).join("\n");
          const dropped = result.dropped ? `[${result.dropped} earlier line(s) dropped]\n` : "";
          return ok(`${dropped}${body || "(no output yet)"}\n[cursor ${result.cursor}]`);
        } catch (error) {
          return err(`Could not read the output: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_release",
      "Give up on a run Telar has lost contact with, so the project can be deployed again. It signals NOTHING — whatever that process was doing may still be running, and stopping it is the human's to do. Only use this after telling them.",
      { runId: z.string().min(1).describe("The run stuck in the unknown state.") },
      async (args) => {
        try {
          const run = await capability.release({ runId: String(args.runId) });
          return ok(`Released ${run.runId}. Telar is no longer tracking that process; if it is still running, it must be stopped by hand.`);
        } catch (error) {
          return err(`Could not release that run: ${failure(error)}`);
        }
      },
    ),
  ];
}
