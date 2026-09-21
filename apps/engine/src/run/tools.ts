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

/**
 * Tools that only read. Handed to the host, which decides the approval posture.
 *
 * `run_wait` IS ON THIS LIST, AND IT IS THE ONE WORTH ARGUING ABOUT. It blocks
 * for up to a minute, which is not what "read" usually suggests — but it
 * SIGNALS NOTHING, STARTS NOTHING AND CHANGES NOTHING, and the alternative an
 * approval prompt produces is the one this tool exists to replace: an agent
 * that cannot wait sleeps and guesses instead. Waiting behind a prompt would
 * make the deterministic path the expensive one.
 */
export const RUN_READ_ONLY_TOOLS = ["run_configs", "run_status", "run_output", "run_wait"] as const;

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
      "Stop the project's deployment — the whole process group, so watchers and child servers go too. Defaults to the live run. This is the ONLY way to stop a run: never use pkill, killall or kill on it.",
      {
        runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now."),
        signal: z
          .enum(["SIGTERM", "SIGINT", "SIGKILL"])
          .optional()
          .describe(
            "Which signal the polite attempt sends. Default SIGTERM. Use SIGINT for a server that traps SIGTERM to drain connections and only really stops on Ctrl-C. If the polite attempt is ignored Telar escalates to SIGKILL by itself, so you do not need to ask for that one.",
          ),
      },
      async (args) => {
        try {
          const run = await capability.stop({
            ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
            ...(args.signal === "SIGTERM" || args.signal === "SIGINT" || args.signal === "SIGKILL" ? { signal: args.signal } : {}),
          });
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
      "Captured stdout and stderr for a run, including after it exited. Output is a bounded window — the oldest lines are dropped under load and the count of dropped lines is reported. Pass the cursor from a previous call to read only what is new; tail, grep and stream narrow what comes back WITHOUT moving that cursor, so you can grep now and still resume over everything later.",
      {
        runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now."),
        after: z.number().int().min(0).optional().describe("A cursor from an earlier call; only newer lines come back."),
        tail: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Only the last N lines of the window. The usual way to look at a dev server: the end is where it says what went wrong."),
        grep: z.string().min(1).max(500).optional().describe("A regular expression; only matching lines come back. The cursor still advances over the ones it hid."),
        stream: z
          .enum(["stdout", "stderr"])
          .optional()
          .describe("One stream only. A run on a terminal has only stdout — a pseudo-terminal is one device and the two were merged before Telar saw them."),
      },
      async (args) => {
        try {
          const result = await capability.output({
            ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
            ...(typeof args.after === "number" ? { after: args.after } : {}),
            ...(typeof args.tail === "number" ? { tail: args.tail } : {}),
            ...(typeof args.grep === "string" ? { grep: args.grep } : {}),
            ...(args.stream === "stdout" || args.stream === "stderr" ? { stream: args.stream } : {}),
          });
          const body = result.lines.map((line) => (line.stream === "stderr" ? `! ${line.text}` : line.text)).join("\n");
          const dropped = result.dropped ? `[${result.dropped} earlier line(s) dropped]\n` : "";
          // WHICH EMPTY THIS IS. "No output yet" and "nothing matched your
          // filter" are different facts, and a model told the first one when
          // the second is true concludes the process is silent and stops
          // looking — or worse, restarts it.
          const narrowed = args.tail !== undefined || args.grep !== undefined || args.stream !== undefined;
          const empty = narrowed ? "(no line in this window matched)" : "(no output yet)";
          return ok(`${dropped}${body || empty}\n[cursor ${result.cursor}]`);
        } catch (error) {
          return err(`Could not read the output: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_wait",
      "Wait until a run says something, becomes ready, or ends — then carry on. THIS IS HOW YOU WAIT FOR A SERVER: never sleep and hope. Give at least one of pattern, ready or exit; the answer says which one fired, so a timeout is distinguishable from a match and you never curl a port nothing is listening on. It returns the lines that arrived while waiting, and a cursor to resume run_output from.",
      {
        runId: z.string().min(1).optional().describe("A specific run. Default: whatever is deployed now."),
        pattern: z.string().min(1).max(500).optional().describe("A regular expression over lines printed from now on, e.g. 'Ready in|Listening on'."),
        ready: z
          .boolean()
          .optional()
          .describe("Wait for the configuration's readinessUrl to answer. Refused if the configuration has none, since that could only ever time out."),
        exit: z.boolean().optional().describe("Wait for the run to finish — the way to wait out a build or a test run."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(60_000)
          .describe("How long to wait, at most 60000. A tool call that can park for ever is a turn that can park for ever, so pick a budget and handle 'timeout'."),
      },
      async (args) => {
        if (args.pattern === undefined && args.ready !== true && args.exit !== true) {
          return err("run_wait needs something to wait FOR: pass pattern, ready or exit. Waiting for nothing is a sleep, which is what this tool exists to replace.");
        }
        try {
          const result = await capability.wait({
            ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
            ...(typeof args.pattern === "string" ? { pattern: args.pattern } : {}),
            ...(args.ready === true ? { ready: true } : {}),
            ...(args.exit === true ? { exit: true } : {}),
            timeoutMs: Number(args.timeoutMs),
          });
          const body = result.lines.map((line) => (line.stream === "stderr" ? `! ${line.text}` : line.text)).join("\n");
          // THE VERDICT FIRST AND IN WORDS. `fired: "timeout"` read past in a
          // wall of log output is how an agent convinces itself a server is up.
          const verdict =
            result.fired === "timeout"
              ? "TIMED OUT — the condition did not happen in the time given. The run may still be starting; do not assume it is up."
              : result.fired === "ready"
                ? "READY — the readiness URL answered."
                : result.fired === "exit"
                  ? "EXITED — the run has finished; run_status says how."
                  : "MATCHED — a line matched your pattern.";
          return ok(`${verdict}\n${body || "(nothing was printed while waiting)"}\n[cursor ${result.cursor}]`);
        } catch (error) {
          return err(`Could not wait on that run: ${failure(error)}`);
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
