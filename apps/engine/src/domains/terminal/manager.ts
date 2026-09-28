import { type RunClosedBy, type RunOutputFilter, type RunOutputLine, type RunStatusEvent, type RunView, type RunWaitAnswer } from "@telar/engine-client";
import fs from "node:fs";
import path from "node:path";
import { nullRunJournal, type RunJournal, type RunRecord } from "./journal";
import { pipeLauncher, type RunHandle, type RunLaunchEvents, type RunLauncher } from "./launcher";
import { processGroupFor, type RunKill } from "./platform";
import { createPtyRedactor, safeCutBack } from "./pty-stream";
import { resolveShell } from "./shell";
import { createOutputSplitter } from "./stream";
import type { TerminalFacts } from "./terminal-client";
import { isTerminal, type RunConfiguration, RunError, type RunProbe, redactText, secretValues, unhideableSecrets } from "./types";
import { CLOSE_SETTLE_MS, compile, defaultProbe, KEEP_FINISHED, type LiveRun, MAX_BYTE_CHARS, MAX_BYTE_CHUNKS, MAX_LINE_CHARS, MAX_LINES, portOf, READY_POLL_MS, type RunManagerOptions, type StartRunInput, WAIT_TICK_MS } from "./live-run";

export class RunManager {
  private readonly runs = new Map<string, LiveRun>();
  private readonly opening = new Set<LiveRun>();
  private readonly watchers = new Set<(event: RunStatusEvent) => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private readonly now: () => number;
  private readonly probe: RunProbe;
  private readonly platform: NodeJS.Platform;
  private readonly launcher: RunLauncher;
  private readonly journal: RunJournal;
  private readonly closeSettleMs: number;
  private readonly readyPollMs: number;
  private readonly personClosed: ((run: RunView) => void) | undefined;

  constructor(options: RunManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? defaultProbe;
    const kill: RunKill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.platform = options.platform ?? process.platform;
    const group = options.processGroup ?? processGroupFor(this.platform, kill);
    this.launcher = options.launcher ?? pipeLauncher(group, options.stopGraceMs === undefined ? {} : { graceMs: options.stopGraceMs });
    this.journal = options.journal ?? nullRunJournal;
    this.closeSettleMs = options.closeSettleMs ?? CLOSE_SETTLE_MS;
    this.readyPollMs = options.readyPollMs ?? READY_POLL_MS;
    this.personClosed = options.personClosed;
  }

  async recover(options: { configFor?: (projectId: string, configId: string) => RunConfiguration | undefined } = {}): Promise<RunView[]> {
    const records = this.journal.list();
    if (records.length === 0) return [];
    if (!this.launcher.held || !this.launcher.adopt) {
      this.forgetJournal([]);
      return [];
    }
    let held: TerminalFacts[];
    try {
      held = await this.launcher.held();
    } catch {
      return [];
    }
    const recovered: RunView[] = [];
    const kept: RunRecord[] = [];
    for (const record of records) {
      const facts = held.find((terminal) => terminal.id === record.terminalId);
      if (!facts || this.runs.has(record.terminalId)) continue;
      const stored = record.configId ? options.configFor?.(record.projectId, record.configId) : undefined;
      const run = this.relisted(record, stored);
      try {
        run.handle = await this.launcher.adopt(facts, this.events(run));
      } catch {
        continue;
      }
      this.register(run);
      if (run.blind) {
        this.log(
          run,
          "stderr",
          "Telar restarted, and the run configuration this terminal came from has since been deleted, so its output is not shown here: it could contain values that configuration marked secret. The terminal itself is still running and can be closed.",
        );
      }
      if (run.readiness.kind === "pending") this.pollReadiness(run);
      kept.push(record);
      recovered.push(this.view(run));
    }
    this.forgetJournal(kept);
    return recovered;
  }

  private relisted(record: RunRecord, stored: RunConfiguration | undefined): LiveRun {
    const config: RunConfiguration = stored ?? {
      id: record.configId ?? "",
      projectId: record.projectId,
      name: record.configName,
      command: record.command,
      ...(record.readinessUrl ? { readinessUrl: record.readinessUrl } : {}),
      createdAt: record.startedAt,
      updatedAt: record.startedAt,
    };
    const { base, instance } = splitTitle(record.title);
    return {
      ...this.blank(),
      terminalId: record.terminalId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      origin: record.origin,
      baseTitle: base,
      instance,
      config,
      configName: record.configName,
      command: record.command,
      worktreePath: record.worktreePath,
      ...(record.worktreeBranch ? { worktreeBranch: record.worktreeBranch } : {}),
      cwd: record.cwd,
      startedAt: record.startedAt,
      readiness: config.readinessUrl ? { kind: "pending" } : { kind: "none" },
      blind: record.configId !== undefined && stored === undefined,
      secrets: stored ? secretValues(stored) : [],
    };
  }

  watch(listener: (event: RunStatusEvent) => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  private announce(run: LiveRun): void {
    if (this.watchers.size === 0 || !this.runs.has(run.terminalId)) return;
    const event: RunStatusEvent = { type: "run.status", projectId: run.projectId, sessionId: run.sessionId, run: this.view(run) };
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch {
      }
    }
  }

  terminals(sessionId: string): RunView[] {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => this.view(run));
  }

  run(terminalId: string): RunView {
    return this.view(this.require(terminalId));
  }

  output(terminalId: string, after = 0, filter: RunOutputFilter = {}): { lines: RunOutputLine[]; cursor: number; dropped: number } {
    const run = this.require(terminalId);
    const start = Math.max(0, after - run.dropped);
    let lines = run.lines.slice(start);
    if (filter.stream) lines = lines.filter((line) => line.stream === filter.stream);
    if (filter.grep !== undefined) {
      const pattern = compile(filter.grep, "grep");
      lines = lines.filter((line) => pattern.test(line.text));
    }
    if (filter.tail !== undefined && lines.length > filter.tail) lines = lines.slice(lines.length - filter.tail);
    return { lines, cursor: run.dropped + run.lines.length, dropped: run.dropped };
  }

  async wait(terminalId: string, options: { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitAnswer> {
    const run = this.require(terminalId);
    const pattern = options.pattern === undefined ? undefined : compile(options.pattern, "pattern");
    run.agentWatching = true;
    if (options.ready && !run.config.readinessUrl && !run.readyPattern) {
      throw new RunError(
        "invalid_request",
        `"${redactText(run.configName, run.secrets)}" has no readiness URL, so waiting for it to be ready could only ever time out. Wait for a pattern in its output instead, or give the configuration a readinessUrl.`,
      );
    }
    const from = run.dropped + run.lines.length;
    const since = () => this.output(terminalId, from).lines;
    const answer = (fired: RunWaitAnswer["fired"], lines: RunOutputLine[]): RunWaitAnswer => ({ fired, cursor: from + lines.length, lines });
    const deadline = Date.now() + options.timeoutMs;

    for (;;) {
      const seen = since();
      if (options.ready && run.readiness.kind === "ready") return answer("ready", seen);
      if (options.exit && isTerminal(run.status)) return answer("exit", seen);
      if (pattern && seen.some((line) => pattern.test(line.text))) return answer("pattern", seen);
      if (isTerminal(run.status)) return answer("exit", seen);
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_TICK_MS, left)));
    }
    return answer("timeout", since());
  }

  bytes(terminalId: string, after = 0): { chunks: string[]; cursor: number; dropped: number } {
    const run = this.require(terminalId);
    const start = Math.max(0, after - run.bytesDropped);
    return { chunks: run.bytes.slice(start), cursor: run.bytesDropped + run.bytes.length, dropped: run.bytesDropped };
  }

  async start(input: StartRunInput): Promise<RunView> {
    if (this.shuttingDown) {
      throw new RunError("conflict", "Telar is shutting down and will not open a new terminal");
    }
    const exposed = unhideableSecrets(input.config);
    if (exposed.length) {
      throw new RunError(
        "invalid_request",
        `${exposed.join(", ")} ${exposed.length === 1 ? "is" : "are"} marked secret but too short or spread over lines to be removed from captured output; change the value or unmark it rather than have Telar print it`,
      );
    }
    const cwd = this.resolveCwd(input);
    const run: LiveRun = {
      ...this.blank(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      origin: input.origin ?? "run",
      baseTitle: input.config.name,
      instance: 0,
      config: input.config,
      configName: input.config.name,
      command: input.config.command,
      worktreePath: input.worktreePath,
      ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
      cwd,
      startedAt: this.now(),
      secrets: secretValues(input.config),
      agentWatching: input.openedBy === "agent",
      ...(input.readyPattern === undefined ? {} : { readyPattern: compile(input.readyPattern, "ready") }),
    };
    run.instance = this.nextInstance(run.sessionId, run.baseTitle);
    this.opening.add(run);
    const work = this.open(run);
    this.pending.add(work);
    try {
      await work;
    } finally {
      this.pending.delete(work);
      this.opening.delete(run);
    }
    return this.view(run);
  }

  async restart(terminalId: string, by: RunClosedBy = "person"): Promise<RunView> {
    const run = this.require(terminalId);
    if (!isTerminal(run.status)) await this.close(terminalId, by);
    return await this.start({
      projectId: run.projectId,
      sessionId: run.sessionId,
      config: run.config,
      worktreePath: run.worktreePath,
      ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
      origin: run.origin,
      ...(run.agentWatching ? { openedBy: "agent" as const } : {}),
      ...(run.readyPattern ? { readyPattern: run.readyPattern.source } : {}),
    });
  }

  private async open(run: LiveRun): Promise<void> {
    if (run.config.readinessUrl) {
      const baseline = await this.probe(run.config.readinessUrl);
      if (baseline.answered) {
        const port = portOf(run.config.readinessUrl);
        run.warning = redactText(
          `port ${port} already answers, so something else may be serving ${run.config.readinessUrl}; this terminal was opened anyway`,
          run.secrets,
        );
        run.readiness = {
          kind: "unattributable",
          reason: redactText(`${run.config.readinessUrl} was already answering before this terminal opened, so a response from it cannot be attributed to this process`, run.secrets),
        };
      } else {
        run.readiness = { kind: "pending" };
      }
    } else if (run.readyPattern) {
      run.readiness = { kind: "pending" };
    }
    if (this.shuttingDown) throw new RunError("conflict", "Telar is shutting down, so it did not open this terminal");

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of run.config.env ?? []) env[entry.key] = entry.value;
    const launch = resolveShell(run.config, this.platform, process.env);
    let handle: RunHandle;
    try {
      handle = await this.launcher.launch(
        {
          file: launch.file,
          args: launch.args,
          cwd: run.cwd,
          env,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          sessionId: run.sessionId,
          origin: run.origin,
          title: this.title(run),
        },
        this.events(run),
      );
    } catch (error) {
      throw new RunError("conflict", redactText(`Telar could not open a terminal for "${run.configName}": ${error instanceof Error ? error.message : String(error)}`, run.secrets));
    }
    run.handle = handle;
    this.register(run);
    this.prune(run.sessionId);
    if (isTerminal(run.status)) {
      this.announce(run);
      return;
    }
    if (handle.pid === undefined && this.launcher.kind === "pipes") {
      this.finish(run, "failed", { error: "the process could not be started (no pid)" });
      return;
    }
    this.announce(run);
    if (run.readiness.kind === "pending" && run.config.readinessUrl) this.pollReadiness(run);
    if (this.launcher.held) {
      try {
        this.journal.open(this.record(run));
      } catch {
      }
    }
  }

  private events(run: LiveRun): RunLaunchEvents {
    return {
      output: this.capture(run),
      failed: (reason) => {
        if (isTerminal(run.status)) return;
        this.finish(run, "failed", { error: reason });
      },
      exited: (detail) => {
        if (isTerminal(run.status)) return;
        const by = run.closing ?? (detail.closed === "close" ? "person" : detail.closed ? "telar" : undefined);
        const code = { ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(detail.signal ? { signal: detail.signal } : {}) };
        if (by) this.finish(run, "closed", { ...code, closedBy: by });
        else this.finish(run, detail.exitCode === 0 || detail.exitCode === undefined ? "exited" : "failed", code);
      },
      gone: (reason) => {
        if (isTerminal(run.status)) return;
        this.finish(run, "closed", { closedBy: run.closing ?? "telar", error: reason });
      },
    };
  }

  private nextInstance(sessionId: string, baseTitle: string): number {
    const used = new Set<number>();
    for (const run of [...this.runs.values(), ...this.opening]) {
      if (run.sessionId === sessionId && run.baseTitle === baseTitle && !isTerminal(run.status) && run.instance > 0) used.add(run.instance);
    }
    let instance = 1;
    while (used.has(instance)) instance += 1;
    return instance;
  }

  private title(run: LiveRun): string {
    return run.instance > 1 ? `${run.baseTitle} #${run.instance}` : run.baseTitle;
  }

  private register(run: LiveRun): void {
    run.terminalId = run.handle?.terminalId ?? run.terminalId;
    this.runs.set(run.terminalId, run);
  }

  private resolveCwd(input: StartRunInput): string {
    if (!path.isAbsolute(input.worktreePath)) {
      throw new RunError("invalid_request", "a run needs the absolute path of the worktree it launches from");
    }
    const root = path.resolve(input.worktreePath);
    const cwd = path.resolve(root, input.config.cwd ?? ".");
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd}" resolves outside the worktree`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new RunError("invalid_request", `there is no directory "${input.config.cwd ?? "."}" in ${root}`);
    }
    if (!stat.isDirectory()) throw new RunError("invalid_request", `"${input.config.cwd}" is not a directory`);

    let realRoot: string;
    let realCwd: string;
    try {
      realRoot = fs.realpathSync(root);
      realCwd = fs.realpathSync(cwd);
    } catch {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd ?? "."}" could not be resolved inside ${root}`);
    }
    if (realCwd !== realRoot && !realCwd.startsWith(`${realRoot}${path.sep}`)) {
      throw new RunError("invalid_request", `the working directory "${input.config.cwd}" is a link out of the worktree: it really points at ${realCwd}`);
    }
    return cwd;
  }

  private record(run: LiveRun): RunRecord {
    const hide = (text: string) => redactText(text, run.secrets);
    return {
      terminalId: run.terminalId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      origin: run.origin,
      title: hide(this.title(run)),
      ...(run.config.id ? { configId: run.config.id } : {}),
      configName: hide(run.configName),
      command: hide(run.command),
      worktreePath: hide(run.worktreePath),
      ...(run.worktreeBranch ? { worktreeBranch: hide(run.worktreeBranch) } : {}),
      cwd: hide(run.cwd),
      ...(run.config.readinessUrl ? { readinessUrl: hide(run.config.readinessUrl) } : {}),
      startedAt: run.startedAt,
    };
  }

  private closeRecord(run: LiveRun): void {
    try {
      this.journal.close(run.terminalId);
    } catch {
    }
  }

  private forgetJournal(kept: RunRecord[]): void {
    try {
      this.journal.replace(kept);
    } catch {
    }
  }

  private capture(run: LiveRun): (stream: "stdout" | "stderr", chunk: string) => void {
    if (this.launcher.kind === "pipes") {
      const splitters = new Map<string, ReturnType<typeof createOutputSplitter>>();
      return (stream, chunk) => {
        let splitter = splitters.get(stream);
        if (!splitter) {
          splitter = createOutputSplitter(run.secrets, MAX_LINE_CHARS, (text) => {
            this.keep(run, `${this.log(run, stream, text)}\r\n`);
          });
          splitters.set(stream, splitter);
        }
        splitter.push(chunk);
      };
    }
    let carry = "";
    const emitLine = (text: string) => this.log(run, "stdout", text);
    const redactor = createPtyRedactor(run.secrets, (text) => {
      const cursor = this.keep(run, text);
      run.handle?.mirror?.(text, cursor);
      carry += text;
      for (let at = carry.indexOf("\n"); at !== -1; at = carry.indexOf("\n")) {
        emitLine(carry.slice(0, at));
        carry = carry.slice(at + 1);
      }
      while (carry.length > MAX_LINE_CHARS) {
        const cut = safeCutBack(carry, [], MAX_LINE_CHARS);
        if (cut <= 0) break;
        emitLine(carry.slice(0, cut));
        carry = carry.slice(cut);
      }
    });
    return (_stream, chunk) => {
      if (!run.blind) redactor.push(chunk);
    };
  }

  private log(run: LiveRun, stream: "stdout" | "stderr", text: string): string {
    const clean = redactText(text.replace(/\r$/, ""), run.secrets).slice(0, MAX_LINE_CHARS);
    run.lines.push({ at: this.now(), stream, text: clean });
    if (run.readyPattern && run.readiness.kind === "pending" && !isTerminal(run.status) && run.readyPattern.test(clean)) {
      run.readiness = { kind: "ready", at: this.now() };
      if (run.status === "running") run.status = "ready";
      this.announce(run);
    }
    if (run.lines.length > MAX_LINES) {
      run.dropped += run.lines.length - MAX_LINES;
      run.lines.splice(0, run.lines.length - MAX_LINES);
    }
    return clean;
  }

  private keep(run: LiveRun, text: string): number {
    if (!text) return run.bytesDropped + run.bytes.length;
    run.bytes.push(text);
    run.byteChars += text.length;
    while (run.bytes.length > MAX_BYTE_CHUNKS || (run.bytes.length > 1 && run.byteChars > MAX_BYTE_CHARS)) {
      const gone = run.bytes.shift();
      if (gone === undefined) break;
      run.byteChars -= gone.length;
      run.bytesDropped += 1;
    }
    return run.bytesDropped + run.bytes.length;
  }

  private pollReadiness(run: LiveRun): void {
    const timer = setInterval(() => {
      if (run.readiness.kind !== "pending" || isTerminal(run.status)) {
        clearInterval(timer);
        return;
      }
      void this.probe(run.config.readinessUrl!).then((result) => {
        if (!result.serving || run.readiness.kind !== "pending" || isTerminal(run.status)) return;
        run.readiness = { kind: "ready", at: this.now() };
        if (run.status === "running") run.status = "ready";
        clearInterval(timer);
        this.announce(run);
      });
    }, this.readyPollMs);
    timer.unref?.();
    run.readyTimer = timer;
  }

  async write(terminalId: string, data: string): Promise<boolean> {
    const run = this.requireLiveKeyboard(terminalId, "type into");
    return await run.handle!.write!(data);
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<boolean> {
    const run = this.requireLiveKeyboard(terminalId, "resize");
    return await run.handle!.resize!(cols, rows);
  }

  private requireLiveKeyboard(terminalId: string, verb: string): LiveRun {
    const run = this.require(terminalId);
    if (isTerminal(run.status) || !run.handle) {
      throw new RunError("conflict", `"${redactText(this.title(run), run.secrets)}" is not running, so there is nothing to ${verb}`);
    }
    if (!run.handle.write || !run.handle.resize) {
      throw new RunError(
        "conflict",
        `"${redactText(this.title(run), run.secrets)}" was started without a terminal — Telar's desktop shell is what provides one — so there is no keyboard to ${verb} with`,
      );
    }
    return run;
  }

  async close(terminalId: string, by: RunClosedBy, signal?: NodeJS.Signals): Promise<RunView> {
    const run = this.require(terminalId);
    if (isTerminal(run.status)) return this.view(run);
    if (!run.closeTask) {
      run.closing = by;
      run.closeTask = this.closeRun(run, signal).finally(() => {
        run.closeTask = undefined;
      });
    }
    await run.closeTask;
    return this.view(run);
  }

  private async closeRun(run: LiveRun, signal?: NodeJS.Signals): Promise<void> {
    const handle = run.handle;
    if (!handle) return;
    if (signal && signal !== "SIGTERM") {
      try {
        await handle.signal(signal);
      } catch {
      }
      if (await this.ended(run, this.closeSettleMs)) return;
    }
    try {
      await handle.close();
    } catch (error) {
      run.closing = undefined;
      throw new RunError(
        "conflict",
        redactText(`Telar could not close "${this.title(run)}": ${error instanceof Error ? error.message : String(error)}`, run.secrets),
      );
    }
    if (await this.ended(run, this.closeSettleMs)) return;
    if (!isTerminal(run.status)) this.finish(run, "closed", { closedBy: run.closing ?? "person" });
  }

  openCount(sessionId: string): number {
    let count = 0;
    for (const run of this.runs.values()) if (run.sessionId === sessionId && !isTerminal(run.status)) count += 1;
    return count;
  }

  openSessions(): string[] {
    return [...new Set([...this.runs.values()].filter((run) => !isTerminal(run.status)).map((run) => run.sessionId))];
  }

  async sessionCounts(): Promise<Record<string, number>> {
    if (this.launcher.sessionCounts) return this.launcher.sessionCounts();
    const counts: Record<string, number> = {};
    for (const sessionId of this.openSessions()) counts[sessionId] = this.openCount(sessionId);
    return counts;
  }

  async closeSession(sessionId: string, by: RunClosedBy = "telar"): Promise<number> {
    const open = [...this.runs.values()].filter((run) => run.sessionId === sessionId && !isTerminal(run.status));
    if (!this.launcher.closeSession) {
      await Promise.allSettled(open.map((run) => this.close(run.terminalId, by)));
      return open.length;
    }
    const stamped = open.filter((run) => !run.closeTask);
    for (const run of stamped) run.closing = by;
    let closed: number;
    try {
      closed = await this.launcher.closeSession(sessionId);
    } catch (error) {
      for (const run of stamped) run.closing = undefined;
      throw error;
    }
    await Promise.all(open.map((run) => this.ended(run, this.closeSettleMs)));
    for (const run of open) if (!isTerminal(run.status)) this.finish(run, "closed", { closedBy: run.closing ?? "telar" });
    return Math.max(closed, open.length);
  }

  private ended(run: LiveRun, ms: number): Promise<boolean> {
    if (isTerminal(run.status)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.waiters = run.waiters.filter((waiter) => waiter !== onEnd);
        resolve(isTerminal(run.status));
      }, ms);
      timer.unref?.();
      const onEnd = () => {
        clearTimeout(timer);
        resolve(true);
      };
      run.waiters.push(onEnd);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled(this.pending);
    if (this.launcher.kind === "pipes") {
      await Promise.allSettled(
        [...this.runs.values()].filter((run) => !isTerminal(run.status)).map((run) => this.close(run.terminalId, "telar")),
      );
    }
    for (const run of this.runs.values()) if (run.readyTimer) clearInterval(run.readyTimer);
    this.launcher.detach?.();
  }

  private require(terminalId: string): LiveRun {
    const run = this.runs.get(terminalId);
    if (!run) throw new RunError("not_found", `no terminal ${terminalId}`);
    return run;
  }

  private blank(): Pick<
    LiveRun,
    "terminalId" | "status" | "readiness" | "blind" | "lines" | "dropped" | "bytes" | "byteChars" | "bytesDropped" | "secrets" | "waiters" | "agentWatching"
  > {
    return {
      terminalId: "",
      status: "running",
      readiness: { kind: "none" },
      blind: false,
      lines: [],
      dropped: 0,
      bytes: [],
      byteChars: 0,
      bytesDropped: 0,
      secrets: [],
      waiters: [],
      agentWatching: false,
    };
  }

  private finish(
    run: LiveRun,
    status: "exited" | "failed" | "closed",
    detail: { exitCode?: number; signal?: string; error?: string; closedBy?: RunClosedBy },
  ): void {
    run.status = status;
    run.endedAt = this.now();
    if (detail.exitCode !== undefined) run.exitCode = detail.exitCode;
    if (detail.signal) run.signal = detail.signal;
    if (detail.error) run.error = redactText(detail.error, run.secrets);
    if (detail.closedBy) run.closedBy = detail.closedBy;
    if (run.readyTimer) clearInterval(run.readyTimer);
    if (run.readiness.kind === "pending") run.readiness = { kind: "none" };
    this.closeRecord(run);
    this.wake(run);
    this.announce(run);
    if (status === "closed" && run.closedBy === "person" && run.agentWatching && this.runs.has(run.terminalId)) {
      try {
        this.personClosed?.(this.view(run));
      } catch {
      }
    }
  }

  private wake(run: LiveRun): void {
    const waiters = run.waiters;
    run.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private prune(sessionId: string): void {
    const finished = [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId && isTerminal(run.status))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (const run of finished.slice(KEEP_FINISHED)) this.runs.delete(run.terminalId);
  }

  private view(run: LiveRun): RunView {
    const hide = (text: string) => redactText(text, run.secrets);
    return {
      terminalId: run.terminalId,
      runId: run.terminalId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      origin: run.origin,
      title: hide(this.title(run)),
      ...(run.config.id ? { configId: run.config.id } : {}),
      configName: hide(run.configName),
      command: hide(run.command),
      worktreePath: hide(run.worktreePath),
      ...(run.worktreeBranch ? { worktreeBranch: hide(run.worktreeBranch) } : {}),
      cwd: hide(run.cwd),
      status: run.status,
      readiness: run.readiness,
      ...(run.config.readinessUrl ? { readinessUrl: hide(run.config.readinessUrl) } : {}),
      ...(run.handle?.pid !== undefined && !isTerminal(run.status) ? { pid: run.handle.pid } : {}),
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(run.closedBy ? { closedBy: run.closedBy } : {}),
      ...(run.warning ? { warning: run.warning } : {}),
      ...(run.error ? { error: run.error } : {}),
      env: (run.config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: hide(entry.value) })),
    };
  }
}

function splitTitle(title: string): { base: string; instance: number } {
  const match = /^(.*) #(\d+)$/.exec(title);
  if (match && Number(match[2]) > 1) return { base: match[1]!, instance: Number(match[2]) };
  return { base: title, instance: 1 };
}
