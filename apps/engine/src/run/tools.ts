/**
 * The `run_*` wall: saved launches, and the terminals they open.
 *
 * "RUN = A NEW TERMINAL", AND THESE TOOLS KEEP THEIR NAMES FOR NOW. Each start
 * opens a new terminal in this session's panel, where the person sees it; none
 * blocks another, so there is no takeover to ask for and no lost run to
 * release. The tools are renamed to `terminal_*` later, with these kept as
 * aliases for a release — what changed here is only what they do.
 *
 * THE AGENT GETS THE SAME RULES AS THE BUTTON: the worktree capture, the
 * session ownership and the redaction all live under this wall in the manager,
 * not in the sentence a skill wrote.
 *
 * A CLOSE FROM HERE IS RECORDED AS THE AGENT'S. Every close says who asked, so
 * a later turn can be told "the person closed it" — and the person is the
 * default everywhere else, which is why this wall always says `agent`.
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
  // WHO CLOSED IT IS THE FACT THAT DECIDES WHAT THE AGENT DOES NEXT. A
  // terminal the person closed was ended on purpose, and reopening it unasked
  // undoes their decision.
  const closed =
    run.status === "closed"
      ? run.closedBy === "person"
        ? " The person closed it — do not reopen it unless they ask."
        : run.closedBy === "telar"
          ? " Telar closed it."
          : " You closed it."
      : "";
  const ended = run.endedAt && run.status !== "closed" ? ` exit ${run.exitCode ?? run.signal ?? "?"}.` : "";
  const warning = run.warning ? ` Warning: ${run.warning}.` : "";
  return `"${run.title}" is ${run.status} (terminal ${run.terminalId}) from ${where}, cwd ${run.cwd}.${readiness}${ended}${closed}${warning}${run.error ? ` ${run.error}` : ""}`;
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
      "Forget a saved run configuration. It does not close anything: a terminal already opened from it keeps its own copy of the command and keeps running.",
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
      "This session's terminals opened from run configurations — the open ones with the worktree each was launched from, then recently ended ones and who closed them. Each has a terminal id; pass it as runId to the other run_* tools. Call it before starting or closing anything.",
      {},
      async () => {
        try {
          const status = await capability.status();
          const where = status.sessionWorktreePath ? `\nThis session's worktree: ${status.sessionWorktreePath}` : "";
          if (!status.terminals.length) return ok(`This session has no terminals from run configurations.${where}`);
          return ok(`${status.terminals.map((run) => `- ${describe(run)}`).join("\n")}${where}`);
        } catch (error) {
          return err(`Could not read the run status: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_start",
      "Open a NEW terminal in this session's panel running a saved configuration, on this session's worktree. The person sees it as a tab. Starting a configuration that is already open opens another instance ('web dev #2') rather than replacing it; if its port already answers you get a warning, and the terminal is still opened.",
      {
        configId: z.string().min(1).describe("Which saved configuration to launch (see run_configs)."),
        replace: z.boolean().optional().describe("Ignored. Every start opens a new terminal; close one with run_stop first if you want only one."),
      },
      async (args) => {
        try {
          const run = await capability.start({ configId: String(args.configId) });
          return ok(`Started ${describe(run)}\nUse run_output with runId ${run.terminalId} to read what it prints.`);
        } catch (error) {
          return err(`Did not start: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_stop",
      "Close a terminal, which ends everything running in it — the whole process group, so watchers and child servers go too. Give the terminal's id when this session has more than one open. This is the ONLY way to stop a run: never use pkill, killall or kill on it.",
      {
        runId: z.string().min(1).optional().describe("The terminal to close (its id from run_status). Default: this session's one open terminal."),
        signal: z
          .enum(["SIGTERM", "SIGINT", "SIGKILL"])
          .optional()
          .describe(
            "A first signal to send before closing. Use SIGINT for a server that traps SIGTERM to drain connections and only really stops on Ctrl-C. If it is ignored the terminal is closed anyway (SIGTERM, then SIGKILL), so you do not need to ask for that.",
          ),
      },
      async (args) => {
        try {
          const run = await capability.stop({
            ...(typeof args.runId === "string" ? { terminalId: args.runId } : {}),
            ...(args.signal === "SIGTERM" || args.signal === "SIGINT" || args.signal === "SIGKILL" ? { signal: args.signal } : {}),
            closedBy: "agent",
          });
          return ok(`Closed ${describe(run)}`);
        } catch (error) {
          return err(`Did not close: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_restart",
      "Close a terminal and open the same configuration on the same worktree in a new one. The new terminal has a new id.",
      { runId: z.string().min(1).optional().describe("The terminal to restart (its id from run_status). Default: this session's one open terminal.") },
      async (args) => {
        try {
          const run = await capability.restart({ ...(typeof args.runId === "string" ? { terminalId: args.runId } : {}), closedBy: "agent" });
          return ok(`Restarted as ${describe(run)}`);
        } catch (error) {
          return err(`Did not restart: ${failure(error)}`);
        }
      },
    ),

    tool(
      "run_output",
      "Captured stdout and stderr for a run, including after it exited. Output is a bounded window — the oldest lines are dropped under load and the count of dropped lines is reported. Pass the cursor from a previous call to read only what is new; tail, grep and stream narrow what comes back WITHOUT moving that cursor, so you can grep now and still resume over everything later.",
      {
        runId: z.string().min(1).optional().describe("The terminal to read (its id from run_status). Default: this session's one open terminal, else the one that ended last."),
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
        runId: z.string().min(1).optional().describe("The terminal to wait on (its id from run_status). Default: this session's one open terminal."),
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
                  ? "EXITED — the terminal has ended; run_status says how, and who closed it if somebody did."
                  : "MATCHED — a line matched your pattern.";
          return ok(`${verdict}\n${body || "(nothing was printed while waiting)"}\n[cursor ${result.cursor}]`);
        } catch (error) {
          return err(`Could not wait on that run: ${failure(error)}`);
        }
      },
    ),

    /**
     * KEPT SO A MODEL THAT LEARNED IT GETS AN ANSWER RATHER THAN "NO SUCH
     * TOOL" — and the answer is that there is nothing to release. It used to
     * free a project's deployment slot held by a run Telar had lost; there is
     * no slot and no lost state now.
     */
    tool(
      "run_release",
      "No longer needed: runs are terminals now, and nothing is ever held for a run Telar lost track of. To end a run, close its terminal with run_stop.",
      { runId: z.string().min(1).optional().describe("Ignored.") },
      async () => ok("Nothing to release: runs are terminals now, and nothing blocks a new start. To end one, close its terminal with run_stop."),
    ),
  ];
}
