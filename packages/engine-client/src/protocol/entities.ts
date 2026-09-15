import { ProjectPlugins } from "./plugins";
/**
 * engine protocol v2 — the durable entities.
 *
 *   Environment
 *     └── Project      a registered repo
 *           └── Session    a durable conversation; survives restart and disconnect
 *                 ├── Runtime  the live provider process, if any (0..1)
 *                 └── Turn     one user input and everything it caused
 *
 * SESSION AND RUNTIME ARE SPLIT; SESSION AND "THREAD" ARE NOT. t3 code carries
 * both a `Thread` (the conversation) and a `ProviderSession` (the process) and
 * the overload is a visible source of confusion in its own code. Here the
 * durable, user-facing thing is a Session and the process attached to it is a
 * Runtime — one session, zero or one live runtime. A session with no runtime is
 * COLD, and reopening it starts a runtime that resumes from the stored cursor.
 */
import { z } from "zod";
import {
  EnvMode,
  EnvironmentId,
  Id,
  InteractionMode,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RateLimitType,
  RuntimeMode,
  Timestamp,
  TurnAttachment,
  UsageSnapshot,
} from "./common";

/**
 * Which Python a project's data-science tooling runs on.
 *
 * A RESOLVED PATH, NOT A MODE. "venv" or "system" would have been a guess made
 * again at every kernel start; a path is one decision, made once by a human
 * from a list the engine detected, and honoured until it stops existing.
 * `source` records how it was picked so the settings page can explain it and
 * re-detect when the file is gone. `path` is relative to the project root when
 * it lives inside the checkout — a worktree session resolves it against its
 * OWN tree, never the project's, so `.venv/bin/python` means "this tree's".
 */
export const DataScienceManager = z.enum(["venv", "conda", "system", "telar"]);
export type DataScienceManager = z.infer<typeof DataScienceManager>;

export const DataSciencePython = z.object({
  source: z.enum(["detected", "chosen", "telar"]),
  path: z.string().min(1),
  resolvedAt: Timestamp,
  /** Which package manager writes to this environment. Derived from the
   *  path when absent (older configs). */
  manager: DataScienceManager.optional(),
  /** The environment's directory, relative like `path` when in the checkout. */
  root: z.string().min(1).optional(),
});
export type DataSciencePython = z.infer<typeof DataSciencePython>;

/**
 * The per-project data-science switch. ABSENT MEANS OFF: a project that never
 * asked gets no kernel, no `notebook_*`/`ds_*` tools and no plots surface, so
 * the many projects that are not analysis work stay exactly as they were.
 * `stack` lists what the optional one-click install put into Telar's own venv;
 * tools gate on the libraries actually importable at kernel start, not on this.
 */
export const DataScienceConfig = z.object({
  enabled: z.boolean(),
  python: DataSciencePython.optional(),
  stack: z.array(z.string().min(1)).optional(),
});
export type DataScienceConfig = z.infer<typeof DataScienceConfig>;

/** One interpreter the engine found, and what it proved about it. */
export const DataSciencePreflight = z.object({
  ok: z.boolean(),
  path: z.string(),
  version: z.string().optional(),
  versionInfo: z.tuple([z.number(), z.number()]).optional(),
  sitePackages: z.array(z.string()).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  /** The project's declared dependencies: distribution name → installed version, null when absent. */
  dists: z.record(z.string(), z.string().nullable()).optional(),
  reason: z.string().optional(),
});
export type DataSciencePreflight = z.infer<typeof DataSciencePreflight>;

/**
 * ONE PYTHON ENVIRONMENT, the way a person thinks of it: a thing with a name,
 * a manager that installs into it, and a place. `python` is absolute — the
 * interpreter the kernel runs; `path` is what gets STORED (relative inside the
 * checkout, so a worktree resolves it against its own tree).
 */
export const DataScienceEnvironment = z.object({
  id: z.string().min(1),
  manager: DataScienceManager,
  name: z.string(),
  root: z.string(),
  python: z.string(),
  path: z.string(),
  location: z.enum(["project", "user", "telar"]),
  reason: z.string(),
  preflight: DataSciencePreflight,
});
export type DataScienceEnvironment = z.infer<typeof DataScienceEnvironment>;

export const DataScienceTool = z.object({ path: z.string(), version: z.string() });
export const DataSciencePythonVersion = z.object({
  version: z.string(),
  minor: z.string(),
  path: z.string().optional(),
  installed: z.boolean(),
  prerelease: z.boolean(),
});
export type DataSciencePythonVersion = z.infer<typeof DataSciencePythonVersion>;

/** The tools environments are made with, and the Pythons uv can see or fetch. */
export const DataScienceToolchain = z.object({
  uv: DataScienceTool.optional(),
  conda: DataScienceTool.extend({ flavour: z.enum(["conda", "mamba", "micromamba"]) }).optional(),
  brew: DataScienceTool.optional(),
  pythons: z.array(DataSciencePythonVersion),
});
export type DataScienceToolchain = z.infer<typeof DataScienceToolchain>;

export const DataScienceRequirementsSource = z.enum(["requirements.txt", "pyproject.toml", "uv.lock", "environment.yml", "Pipfile"]);
export type DataScienceRequirementsSource = z.infer<typeof DataScienceRequirementsSource>;

/** `GET /v2/projects/:id/data-science/environments`. */
export const DataScienceEnvironments = z.object({
  toolchain: DataScienceToolchain,
  environments: z.array(DataScienceEnvironment),
  /** Dependency manifests the checkout carries. */
  requirements: z.array(DataScienceRequirementsSource),
  /** What the project declares (canonical distribution names); each environment's preflight `dists` answers for these. */
  declared: z.array(z.string()).optional(),
  /** The id of the environment the project is configured on, when it was found. */
  currentId: z.string().optional(),
});
export type DataScienceEnvironments = z.infer<typeof DataScienceEnvironments>;

/** A toolchain job — an install, a build — read by cursor. */
export const DataScienceJob = z.object({
  jobId: z.string(),
  kind: z.string(),
  status: z.enum(["running", "ok", "failed", "cancelled"]),
  lines: z.array(z.string()),
  cursor: z.number().int().min(0),
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
});
export type DataScienceJob = z.infer<typeof DataScienceJob>;

/** `direct` is set only when the project declares dependencies: true for a declared one, false for what came along with them. */
export const DataSciencePackage = z.object({ name: z.string(), version: z.string(), channel: z.string().optional(), direct: z.boolean().optional() });
export type DataSciencePackage = z.infer<typeof DataSciencePackage>;

/** Which command package installs run, so the page can say so up front. */
export const DataScienceInstallCommand = z.enum(["uv add", "uv pip", "conda", "pip"]);
export type DataScienceInstallCommand = z.infer<typeof DataScienceInstallCommand>;

export const DataScienceCreateEnvironment = z.discriminatedUnion("manager", [
  z.object({ manager: z.literal("venv"), location: z.enum(["project", "telar"]), python: z.string().min(1), stack: z.boolean().optional() }),
  z.object({ manager: z.literal("conda"), name: z.string().min(1), python: z.string().min(1), stack: z.boolean().optional() }),
]);
export type DataScienceCreateEnvironment = z.infer<typeof DataScienceCreateEnvironment>;

export const DataScienceBootstrap = z.discriminatedUnion("what", [
  z.object({ what: z.literal("uv") }),
  z.object({ what: z.literal("python"), version: z.string().min(1) }),
  z.object({ what: z.literal("conda") }),
]);
export type DataScienceBootstrap = z.infer<typeof DataScienceBootstrap>;

/** What a finished create-environment job carries in `result`. */
export const DataScienceCreatedEnvironment = z.object({
  path: z.string(),
  root: z.string(),
  manager: DataScienceManager,
  source: z.enum(["detected", "chosen", "telar"]),
});
export type DataScienceCreatedEnvironment = z.infer<typeof DataScienceCreatedEnvironment>;

/**
 * Which program family compiles this project's documents. Two managers, both
 * first-class: `tectonic` is a single self-contained binary that fetches TeX
 * packages on first use; `texlive` is a distribution root (MacTeX, TinyTeX, a
 * vanilla TeX Live) whose packages tlmgr manages.
 */
/**
 * `managed` is Telar's OWN Tectonic — the copy the engine downloads into its
 * state root so a Mac with no TeX on it still compiles. It is a THIRD kind
 * rather than a `tectonic` choice pointing at that path, and the reason is
 * upgrades: the managed install is versioned on disk, so a stored absolute path
 * would go stale the day the pinned version moves and would resolve to a
 * directory that is no longer there. `managed` names the INTENT — "whatever
 * Telar manages" — and the engine resolves it to today's binary.
 */
export const LatexToolchainKind = z.enum(["tectonic", "texlive", "managed"]);
export type LatexToolchainKind = z.infer<typeof LatexToolchainKind>;

/** Telar's own Tectonic, as the settings pane sees it. See `latex/managed.ts`. */
export const ManagedTectonic = z.object({
  version: z.string(),
  /** False on a platform Telar has no release table entry for. */
  supported: z.boolean(),
  installed: z.boolean(),
  path: z.string().optional(),
  installing: z.boolean(),
  error: z.string().optional(),
});
export type ManagedTectonic = z.infer<typeof ManagedTectonic>;

/** What latexmk drives. Tectonic ignores it — it is XeTeX inside. */
export const LatexEngine = z.enum(["pdflatex", "lualatex", "xelatex"]);
export type LatexEngine = z.infer<typeof LatexEngine>;

/**
 * The distribution a project compiles with. `path` is ABSOLUTE — the tectonic
 * binary, or a TeX Live bin directory — because a TeX distribution is a
 * machine-level thing that can never live inside a checkout, so the relative
 * worktree rule `DataSciencePython.path` follows would be a lie here.
 */
export const LatexToolchainChoice = z.object({
  kind: LatexToolchainKind,
  path: z.string().min(1).optional(),
  engine: LatexEngine.optional(),
});
export type LatexToolchainChoice = z.infer<typeof LatexToolchainChoice>;

/**
 * The per-project LaTeX switch. ABSENT MEANS OFF, exactly like `dataScience`:
 * a project that never asked gets no `latex_*` tools and no LaTeX surface.
 * `mainFile` is RELATIVE to the checkout and the worktree rule applies — a
 * worktree session resolves it against its OWN tree, never the project's.
 */
export const LatexConfig = z.object({
  enabled: z.boolean(),
  toolchain: LatexToolchainChoice.optional(),
  mainFile: z.string().min(1).optional(),
});
export type LatexConfig = z.infer<typeof LatexConfig>;

export const LatexTool = z.object({ path: z.string(), version: z.string() });
export type LatexTool = z.infer<typeof LatexTool>;

/** One TeX Live root the engine found, and which programs it actually holds. */
export const LatexTexliveDistribution = z.object({
  binDir: z.string(),
  flavour: z.enum(["mactex", "tinytex", "texlive"]),
  year: z.string().optional(),
  latexmk: LatexTool.optional(),
  pdflatex: LatexTool.optional(),
  lualatex: LatexTool.optional(),
  xelatex: LatexTool.optional(),
  tlmgr: LatexTool.optional(),
  kpsewhich: LatexTool.optional(),
});
export type LatexTexliveDistribution = z.infer<typeof LatexTexliveDistribution>;

/** The TeX programs this machine carries. A LIST, never a choice. */
export const LatexToolchain = z.object({
  tectonic: LatexTool.optional(),
  texlive: z.array(LatexTexliveDistribution),
  brew: LatexTool.optional(),
  /** Telar's own Tectonic — present even when not yet fetched, so a pane has
   *  something to offer rather than an absence to explain. */
  managed: ManagedTectonic.optional(),
});
export type LatexToolchain = z.infer<typeof LatexToolchain>;

/** `GET /v2/projects/:id/latex/distributions`. */
export const LatexDistributions = z.object({
  toolchain: LatexToolchain,
  /** `.tex` files carrying `\documentclass`, candidates for `mainFile`. */
  mainCandidates: z.array(z.string()),
  /** The configured choice, echoed so the UI can mark the current card. */
  current: LatexToolchainChoice.optional(),
});
export type LatexDistributions = z.infer<typeof LatexDistributions>;

export const LatexBootstrap = z.discriminatedUnion("what", [
  z.object({ what: z.literal("tectonic") }),
  z.object({ what: z.literal("tinytex") }),
]);
export type LatexBootstrap = z.infer<typeof LatexBootstrap>;

/** One thing the log parser understood, phrased for a person or an agent. */
export const LatexDiagnostic = z.object({
  severity: z.enum(["error", "warning"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  message: z.string(),
  code: z
    .enum([
      "missing-package",
      "missing-file",
      "undefined-control-sequence",
      "undefined-reference",
      "citation-undefined",
      "overfull",
      "other",
    ])
    .optional(),
  detail: z.string().optional(),
  suggestion: z.string().optional(),
});
export type LatexDiagnostic = z.infer<typeof LatexDiagnostic>;

/** The last compile a session ran, kept whole for the surface and the tools. */
export const LatexCompileStatus = z.object({
  status: z.enum(["running", "ok", "failed", "cancelled"]),
  path: z.string(),
  pdfPath: z.string().optional(),
  diagnostics: z.array(LatexDiagnostic),
  logTail: z.array(z.string()),
  jobId: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
});
export type LatexCompileStatus = z.infer<typeof LatexCompileStatus>;

/**
 * The two managers disagree about what "packages" even means, and this answer
 * refuses to paper over it: tectonic fetches automatically (nothing to list),
 * tlmgr manages a real inventory, and a TeX Live without a usable tlmgr says
 * so instead of showing an empty list that reads as "none installed".
 */
export const LatexPackagesAnswer = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic"), note: z.string() }),
  z.object({
    mode: z.literal("managed"),
    packages: z.array(
      z.object({ name: z.string(), revision: z.string().optional(), description: z.string().optional() }),
    ),
  }),
  z.object({ mode: z.literal("unavailable"), reason: z.string() }),
]);
export type LatexPackagesAnswer = z.infer<typeof LatexPackagesAnswer>;

/** Same wire shape as a data-science job — one JobRunner, one job format. */
export const LatexJob = DataScienceJob;
export type LatexJob = z.infer<typeof LatexJob>;

export const Project = z.object({
  id: Id,
  environmentId: EnvironmentId,
  name: z.string().min(1),
  root: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /**
   * WHAT THIS CHECKOUT IS ON RIGHT NOW — for the sessions that share it.
   *
   * A worktree session carries its own branch on `SessionWorkspace`; a LOCAL
   * session has none, because it runs on the project's own checkout and the
   * branch is a property of that checkout rather than of the conversation. So
   * the sidebar could say where a worktree session's work lands and not where
   * a local one's does, which is the more common case.
   *
   * DERIVED ON LIST, LIKE `Session.activity`, and for the same reason: HEAD
   * moves, and a stored answer would be wrong the first time somebody switched
   * branches. One `git rev-parse` per PROJECT rather than per session is what
   * makes it affordable.
   *
   * Absent on an unversioned directory, which `envMode: "local"` exists to
   * support — not every project is a git repository.
   */
  branch: z.string().min(1).optional(),
  /**
   * Present when the engine found an icon file in the project's checkout —
   * a favicon, an app icon, a `.telar/icon.*`. The value is an opaque cache
   * key derived from the file's path, mtime and size; the bytes are served by
   * `GET /v2/projects/:id/icon`. Because the key changes whenever the file
   * does, a client may cache the bytes immutably against `?v=<icon>`.
   *
   * DERIVED ON LIST like `branch` above, and for the same reason: the file
   * lives in somebody's working tree and changes without telling the engine.
   */
  icon: z.string().min(1).max(64).optional(),
  /**
   * THE GLYPH THE READER CHOSE, which outranks the one above.
   *
   * `icon` is what the checkout HAPPENS to carry and is discovered; this is
   * what a person picked on the Projects pane, and it is STORED. A separate key
   * rather than a second meaning for `icon`, because that one is a cache key the
   * engine serves bytes against (`GET /v2/projects/:id/icon`) — a client handed
   * a glyph name there would ask the engine for a file that does not exist. Two
   * fields, two questions, and a surface that prefers this one answers "what
   * does this project look like" without ever having to know which kind of
   * answer it got.
   *
   * A NAME, NOT A PICTURE. The value is one id out of `TELAR_ICONS` — the
   * identity vocabulary browser profiles spend too (`src/icons.ts`) — which is a
   * lucide id in lucide's own kebab-case: `flask-conical`, `rocket`, `terminal`.
   *
   * THE SHAPE IS CHECKED HERE, NOT THE MEMBERSHIP, and that is `isTelarIcon`'s
   * whole reason to exist: a registry written by a build whose set had one more
   * glyph must still be READ rather than thrown away, and the renderer falls
   * back for a name it cannot draw. Validating the enum here would turn a
   * downgrade into a project that fails to load.
   */
  iconName: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  /**
   * THE TYPED MARK, KEPT FOR WHAT IS ALREADY STORED (#364).
   *
   * This was `iconName`'s predecessor — a grapheme somebody typed — and the
   * picker that wrote it is gone: an emoji is a different size, weight and
   * colour from every other glyph in the rail, which is what made the row read
   * as a novelty rather than as a setting. The FIELD stays, because a registry
   * written by an older cockpit still carries marks, and silently dropping one
   * on the next write is a worse answer than rendering it. Nothing writes it
   * now but `null`, which is how the picker's Auto-detect clears one.
   *
   * A GRAPHEME, NOT A SENTENCE. The cap is in UTF-16 code units and is
   * generous on purpose: one emoji can be a ZWJ sequence of five.
   */
  iconEmoji: z.string().min(1).max(16).optional(),
  /**
   * WHAT A CONVERSATION IN THIS PROJECT OPENS ON, when nobody says otherwise.
   *
   * BOTH ARE OPTIONAL, AND ABSENCE IS A REAL ANSWER rather than a missing one:
   * it means "whatever this Mac's standing answer is" — `SessionDefaults` for
   * the workspace, and the provider's own default for the model. That is what
   * makes a project able to DIFFER from the machine without every project
   * having to restate what the machine already says.
   */
  defaultModel: ModelSelection.optional(),
  envMode: EnvMode.optional(),
  /**
   * WHICH REPOSITORY THIS IS A CHECKOUT OF — `origin`, reduced to
   * `host/owner/repo` (see the engine's `normalizeRemote`).
   *
   * NOT A URL, despite the name the rail asked for: the scheme, the `git@`, the
   * port, any credentials and the `.git` are all gone, because this exists to
   * be COMPARED rather than followed. Two Macs that cloned one repository
   * answer the same string here however differently each of them spelled its
   * remote, and that is what lets the rail draw their two registrations as one
   * project instead of two with the same name.
   *
   * DERIVED ON LIST, like `branch` and `icon` above, and for their reason: a
   * value stored at registration would be wrong the first time somebody added
   * an origin, moved a repository, or renamed it on the host — and the rail
   * would go on merging (or refusing to merge) on an address that no longer
   * exists. One `git config --get` per project per poll, on the same refresh.
   *
   * Absent on a checkout with no origin, on a directory that is not a
   * repository at all (`envMode: "local"` supports both), and on a remote with
   * no host to name — a local path, which names a disk rather than a repository
   * and must never merge two Macs.
   */
  remoteUrl: z.string().min(1).optional(),
  /**
   * WHEN THIS REGISTRATION WAS PUT AWAY, if it was.
   *
   * Removing a project from Telar is REVERSIBLE and keeps this record whole:
   * the id, the name, the checkout path and every opt-in block below stay
   * exactly as they were, and only this timestamp is added. That is what makes
   * restoring the same folder give back the SAME project rather than a
   * stranger wearing its name — sessions store a project id, MCP servers are
   * scoped by one, and browser profiles are keyed by one, so a new id on
   * re-registration would orphan all three.
   *
   * ABSENT FROM `listProjects` BY DEFAULT: a removed project is gone from every
   * picker, the sidebar and the new-session surfaces, and the engine refuses to
   * start new work on it. `?includeRemoved=1` is how the one surface that has
   * to name it — its own settings page, offering to put it back — asks.
   */
  removedAt: Timestamp.optional(),
  /** Opt-in data-science tooling. Stored, not derived. See `DataScienceConfig`. */
  dataScience: DataScienceConfig.optional(),
  /** Opt-in LaTeX tooling. Stored, not derived. See `LatexConfig`. */
  latex: LatexConfig.optional(),
  /**
   * THE PLUGIN MAP — the last per-feature block this record grows.
   *
   * `dataScience` and `latex` above are two bespoke optional blocks, each with
   * its own patch arm; a third would have been a third arm. Everything after
   * them is an entry here, and those two are MIRRORED into it so a rollback to
   * an engine that predates this key keeps the user's settings.
   */
  plugins: ProjectPlugins.optional(),
});
export type Project = z.infer<typeof Project>;

/** Lifecycle of the conversation itself, independent of whether a process is
 *  currently attached to it. */
export const SessionState = z.enum(["active", "archived"]);
export type SessionState = z.infer<typeof SessionState>;

/**
 * WHO ASKED FOR THIS SESSION TO EXIST — provenance, and deliberately NOT a link.
 *
 * The `sessions` toolkit lets one session create another. It does NOT create a
 * parent, a child, a depth or an attachment: the two are peers the moment the
 * second one exists, and nothing here records WHICH session made the call. What
 * it records is that an agent asked, not a hand — and it exists for exactly one
 * mechanical reason: with no depth rule, a plain COUNT of live agent-made
 * sessions is the only thing standing between a loop and forty worktrees.
 *
 * ABSENT MEANS "human", and must be read that way rather than as unknown: every
 * session written before this field existed was opened from a surface a person
 * was looking at.
 */
export const SessionOrigin = z.enum(["human", "session"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/**
 * WHAT A SESSION IS DOING, ordered by what it wants from the reader.
 *
 *   blocked     a request is open and nobody has answered it — it wants YOU
 *   working     a turn is running, or a sub-agent is; it wants nothing, it is busy
 *   queued      a turn is waiting for a worker to pick it up
 *   monitoring  no turn, no agent — but a watch loop or long shell is alive
 *   idle        nothing in flight
 *
 * THE ORDER IS THE POINT and it is not the order of severity — `blocked` is not
 * worse than `working`, it is more ACTIONABLE, and a sidebar exists to answer
 * "what needs me" before "what is happening". A session that is both blocked
 * and working reports blocked.
 *
 * `monitoring` EXISTS BECAUSE A SESSION CAN BE ALIVE WITH NO TURN. `TaskKind`
 * says so in as many words — a background task "continues after the turn that
 * started it settles. This is why a session can be 'still working' with no
 * active turn" — and until it was added, every such session reported `idle`. The
 * row went quiet while the work went on, which is the one thing an inbox may not
 * do. `livenessOf` in ./tasks.ts is the fold, and the engine applies it.
 *
 * IT IS BELOW `queued` AND ABOVE `idle` on purpose: background watching is real
 * work and deserves a badge, but it is nobody's turn and it can run for hours,
 * so it must not outrank a turn that is actually about to answer you.
 */
export const SessionActivity = z.enum(["blocked", "working", "queued", "monitoring", "idle"]);
export type SessionActivity = z.infer<typeof SessionActivity>;

/**
 * Where a session's work lands on disk. `worktree` sessions get a checkout of
 * their own, created through the engine's `vcs.ts`, so N detached sessions
 * on one project do not collide.
 */
export const SessionWorkspace = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local"),
    path: z.string().min(1),
    /**
     * The commit HEAD pointed at when this session was created.
     *
     * A WORKTREE SESSION HAS ALWAYS HAD ONE and a local session never did, which
     * made "what has this session done to the repository" answerable for half of
     * them. It is the only anchor that survives the agent committing: `git
     * status` forgets a commit the moment it lands, and a branch comparison
     * forgets everything still uncommitted. Optional because sessions created
     * before this existed have no base — the review surface falls back to HEAD
     * and says which question it is answering.
     */
    baseRef: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("worktree"),
    path: z.string().min(1),
    branch: z.string().min(1),
    /** The commit the worktree was cut from, so a stale one is detectable. */
    baseRef: z.string().min(1).optional(),
  }),
]);
export type SessionWorkspace = z.infer<typeof SessionWorkspace>;

/**
 * THE CHECKOUT IS NOT THERE YET, OR NEVER WILL BE — issue #496.
 *
 * `git worktree add` on a large checkout is seconds, and it used to run
 * synchronously inside `POST /v2/sessions`, which froze the daemon's event loop
 * for the duration: every cockpit's poll and every agent's stream stopped
 * together while one person opened one conversation. It runs in the background
 * now, so the route answers immediately and the row says what is still true —
 * that its workspace is being made.
 *
 * ABSENT MEANS READY, and that is the state almost every row is in: a `local`
 * session never has one, and a worktree session carries it for the seconds
 * between its creation and its cut. Readers must treat absence as ready rather
 * than as unknown — a client that waited for a positive "ready" would hang on
 * every session written before this field existed.
 *
 * NOT A `SessionState`. That enum is the CONVERSATION's lifecycle — active or
 * archived, a thing a person decides — and this is a fact about a directory.
 * Folding them together would have made `state !== "active"` (which the engine
 * asks in a dozen places, and the phone in several) quietly mean "or still being
 * prepared", and a preparing session would have been treated as one that is
 * over.
 *
 * `error` IS GIT'S OWN STDERR, not a rewrite of it. A cut fails for reasons a
 * sentence of ours would flatten — a branch that exists, a locked index, a full
 * disk — and the person who can act on it is the one reading the row.
 */
export const SessionPreparation = z.object({
  state: z.enum(["preparing", "failed"]),
  /** Only ever on `failed`, and only what git said. */
  error: z.string().optional(),
  at: Timestamp,
});
export type SessionPreparation = z.infer<typeof SessionPreparation>;

/**
 * WHY A ROW IS ON THE SHELF, WHEN THE ENGINE PUT IT THERE — issue #378.
 *
 * `settledOverride: "settled"` was only ever a human's decision, and it says
 * nothing about whose. The engine now settles a DELEGATE once the coordinator
 * has taken delivery of its result, and a shelf that shelved a conversation
 * without saying why is a shelf people stop trusting — so the reason travels
 * with the decision rather than being reconstructed by whichever client is
 * drawing the row.
 *
 * `kind` IS A UNION OF ONE, deliberately. Delegation is the only thing the
 * engine settles on today; naming it leaves room for a second reason without
 * a client having to guess that an unlabelled stamp meant this one.
 *
 * `runId` IS THE ASSIGNMENT'S IDENTITY — the task turn's run, the same id
 * `SessionAssignment.taskRunId` carries — and NOT the run that did the work.
 * It is what the never-re-settle record (`unsettledAssignments`) is keyed on:
 * a human taking a row back off the shelf is answering about one errand, and
 * the errand is the task they were handed.
 */
export const SessionSettledBy = z.object({
  kind: z.literal("delegation"),
  /** Who the work was for. Their title is what a row's hint names. */
  coordinatorSessionId: Id,
  runId: Id,
  at: Timestamp,
});
export type SessionSettledBy = z.infer<typeof SessionSettledBy>;

export const Session = z.object({
  id: Id,
  /**
   * WHICH PROJECT THIS SESSION BELONGS TO — and OPTIONAL, which is new and is
   * the whole of what makes a project-less session expressible.
   *
   * Every ordinary session has one. A session that answers across projects
   * must not carry one, because carrying a project would scope it to the one
   * thing it must not be scoped to.
   *
   * ABSENT IS NOT "UNKNOWN". It is a positive statement that this session has
   * no project, and readers must treat it as one: MCP resolution reads it as
   * "the environment's global servers and no project's", and a project-scoped
   * list simply does not contain it. A reader that treats absence as an error
   * turns a valid session into a bug report.
   */
  projectId: Id.optional(),
  environmentId: EnvironmentId,
  title: z.string(),
  state: SessionState,
  /** Provenance, never a link — see `SessionOrigin`. Absent is "human". */
  origin: SessionOrigin.optional(),
  /**
   * WHICH SESSION THIS ONE WAS STARTED FROM. Permanent, engine-stamped, and
   * never cleared.
   *
   * `origin` says an agent asked; this says WHO, which is the question a person
   * reading a session list actually has. Stamped from the same proof
   * `Turn.sender` is — the creating turn's claim token — so a model cannot claim
   * a provenance it does not have.
   *
   * IT IS NOT A LIFETIME, A PERMISSION OR A CANCELLATION PATH. The two sessions
   * remain independent peers; this records where one came from and nothing else.
   * A free continuation carries this and no assignment.
   */
  startedFrom: z
    .object({ sessionId: Id, runId: Id.optional() })
    .optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,

  /** Routing is by instance; the driver is descriptive. See ./common.ts. */
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: ModelSelection.optional(),

  workspace: SessionWorkspace,
  /** Absent means the workspace is ready. See `SessionPreparation`. */
  preparation: SessionPreparation.optional(),
  envMode: EnvMode,
  /** Browser-only conversation. Workspace creation is deferred until first send. */
  draft: z.object({ baseRef: z.string().optional(), branchName: z.string().optional(), branchSlug: z.string().optional() }).optional(),

  /** What this session may do without asking. Set at creation, changeable
   *  mid-session — a human can hand a running session more rope, or take it. */
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,

  /**
   * Whether a human is expected to be watching.
   *
   * IT IS A DECLARATION, NOT AN OBSERVATION. The engine never requires a client
   * to be connected — detached is the default posture, not a mode you switch
   * into. This field says what the session should DO when a request opens with
   * nobody home, and it is what a notification policy reads.
   */
  detached: z.boolean(),

  /** Cumulative across every turn. Per-turn figures live on the turn. */
  usage: UsageSnapshot.optional(),

  /**
   * WHAT THIS SESSION IS DOING RIGHT NOW — the field that makes a list an inbox.
   *
   * A sidebar without this can only sort by recency, so every row reads the
   * same and "8h ago" is the most it can say. What a person actually scans for
   * is the opposite: which of these is asking me something, which is still
   * going, which is finished. `updatedAt` cannot answer any of the three.
   *
   * `blocked` OUTRANKS `working` DELIBERATELY. A session with a parked request
   * IS still running a turn, so both are true at once — and only one of them is
   * the reader's to act on. Sorting the union by "what does this want from me"
   * is the whole design, and it is decided here rather than in each client.
   *
   * DERIVED, NEVER STORED. It is a read over the queue and the open requests,
   * so it cannot drift from them the way a cached flag would when a worker dies
   * mid-turn.
   */
  activity: SessionActivity.default("idle"),
  /**
   * When the current activity began — for "Working 3m", not for sorting.
   *
   * Absent on `idle`, because there is no event to date: a session that is
   * doing nothing has been doing nothing since its last turn ended, which
   * `updatedAt` already says.
   */
  activityAt: Timestamp.optional(),

  /**
   * WHEN THE LAST TURN ENDED, AND WHETHER IT ENDED BADLY.
   *
   * Derived beside `activity`, off the same queue read, and here for exactly
   * one rule: A SNOOZE IS "NOT NOW", NOT "NEVER". A session may be snoozed
   * while a turn is running — that is the whole difference between snoozing and
   * settling — so the work you deferred can finish while the row is hidden, and
   * a client with no way to notice keeps it hidden until a wake time chosen
   * before the answer existed.
   *
   * `lastTurnFailed` is the second half of the same rule and is not a duplicate
   * of `activity`: a failure is not a state a session is IN, it is something
   * that happened to it, and by the time anyone reads this the session is idle
   * again. Both are absent until a turn has ended, which is not the same as
   * zero.
   */
  lastTurnEndedAt: Timestamp.optional(),
  /**
   * IS THERE AN ANSWER NOBODY HAS READ — the pair, and the two halves are
   * deliberately different kinds of thing.
   *
   * `lastTurnSequence` is DERIVED, off the same queue read as `activity`: the
   * sequence of the newest turn that left a RESULT (completed, failed or
   * stopped). Not the newest turn that ENDED — a message steered into a
   * running turn and a discarded recovery both end, and neither is an answer
   * to read. A session that has never produced a result has none, which is
   * why absent means "nothing to read" rather than "unknown".
   *
   * `lastReadTurnSequence` is PERSISTED, and only moves forward: it is the
   * highest result a human has actually been shown, so a receipt that arrives
   * after newer work landed cannot mark that newer work read. Comparing the
   * two is the whole of unread — no counter, no per-client bookkeeping, and
   * the same answer on every device.
   *
   * WHY A SEQUENCE RATHER THAN A TIMESTAMP: a clock can tie, or step
   * backwards, and says nothing about which of two turns came first.
   * `readAt` rides along for the inactivity rule (see `session-settling.ts`),
   * never for ordering.
   */
  lastTurnSequence: z.number().int().positive().optional(),
  lastReadTurnSequence: z.number().int().positive().optional(),
  /** When the newest read receipt landed. Never bumps `updatedAt`: reading a
   *  session is a fact about the reader, not work the session did. */
  readAt: Timestamp.optional(),
  lastTurnFailed: z.boolean().optional(),

  /**
   * THE INBOX'S OWN STATE, WHICH IS NOT THE SESSION'S LIFECYCLE.
   *
   * `state` answers "is this conversation over"; these answer "do I want to see
   * it right now". A settled session is still live and still resumable — it has
   * simply been moved off the top of the list — where an archived one is
   * finished. Conflating the two is what makes people archive things they only
   * wanted out of the way, and then go looking for them.
   *
   * MODELLED ON t3 code's thread settling. Its three-way shape is the part
   * worth copying exactly:
   *
   *   - `settledOverride` is a PIN IN EITHER DIRECTION, not a boolean. "settled"
   *     shelves a session the inactivity rule would have kept; "active" keeps
   *     one the inactivity rule would have shelved. Absent means "let the rule
   *     decide", which is a third answer neither boolean can express.
   *   - A SETTLE NEVER GOES STALE SILENTLY, AND A PIN IS NEVER CLEARED BY
   *     WORK: queueing a turn lifts a "settled" override, so a shelved session
   *     that gets a new message comes back on its own rather than staying
   *     hidden while it works — but an "active" pin survives every turn, wake
   *     and peer message. The two directions are opposite decisions in one
   *     field, and treating "new work" as reason to drop either of them threw
   *     away pins the reader had set on purpose.
   *   - A SNOOZE IS AN OVERLAY, NOT A STATE. The session stays exactly as
   *     active as it was; it is only suppressed from the list until its wake
   *     time — and clients raise its hand early when something outranks the
   *     snooze. That rule lives on the client because it is a question about
   *     presentation, and the two stamps here are everything it needs.
   *
   * WHY THE ENGINE HOLDS THEM AT ALL, rather than a browser's local storage:
   * the same sessions are read from the desktop shell, a browser tab and
   * whatever else attaches, and an inbox that disagrees with itself per client
   * is not an inbox. Read receipts above are also engine-owned.
   */
  settledOverride: z.enum(["settled", "active"]).optional(),
  /** When the override was set. Its age is what lets a client tell an old
   *  decision from a fresh one. */
  settledAt: Timestamp.optional(),
  /**
   * THE ENGINE'S OWN REASON, when the settle was not a person's — see
   * `SessionSettledBy`. Always accompanied by `settledOverride: "settled"`;
   * a human patch in either direction clears it, because the reason described
   * a decision that is no longer the standing one.
   */
  settledBy: SessionSettledBy.optional(),
  /**
   * ERRANDS A HUMAN TOOK BACK OFF THE SHELF, by `SessionAssignment.taskRunId`.
   *
   * A settle the reader undid is an argument the engine does not get to have
   * twice: the facts that produced it (the assignment finished, the result was
   * delivered) are permanent, so without this record the very next evaluation
   * would shelve the row again and the un-settle would read as a button that
   * does nothing. Bounded, and the bound is generous — it is one id per errand
   * a person disagreed about, not per turn.
   */
  unsettledAssignments: z.array(Id).max(64).optional(),
  /** Hidden from the list until this passes. */
  snoozedUntil: Timestamp.optional(),
  /** When the snooze was set — the baseline "what has happened SINCE" is
   *  measured from, which is what makes an early wake possible. */
  snoozedAt: Timestamp.optional(),

  /** Provider continuity for the NEXT runtime. Opaque; the engine owns it. */
  resumeCursor: z.string().min(1).optional(),

  /**
   * SIT OUT A USAGE LIMIT AND CARRY ON — the session's answer to a turn that
   * failed `rate_limited`.
   *
   * ABSENT MEANS ON FOR A CLAUDE SESSION, off for anything else, and the
   * default is deliberately not written into the record: a session created
   * before this existed behaves like one created after it, and a provider that
   * grows the same reporting later starts resuming without a migration. Only an
   * explicit `false` (or an explicit `true` on another driver) is stored, which
   * is exactly what a person changing the toggle means.
   *
   * WHAT IT DOES NOT DO: it never re-sends anything. The CLI resumes the same
   * provider session, so the turn continues with its context rather than
   * replaying a prompt — and with it off, the turn simply stays failed with its
   * reset time on the row, which is what it did before this setting existed.
   */
  resumeAfterRateLimit: z.boolean().optional(),

  /** A human Stop rejects new agent messages/wakes until a new human message.
   * It never holds or replays an old backlog. */
  agentMessagesBlocked: z.boolean().optional(),

  /** Legacy pause metadata, accepted when reading older state. Startup and
   * session Stop settle its held backlog and remove the latch without replay.
   * New clients use session Stop; no command creates a pause latch. */
  paused: z
    .object({
      at: Timestamp,
      /** Who paused it: a person, or an agent through `sessions_stop`. */
      by: z.enum(["human", "session"]),
    })
    .optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * WHAT A RAIL DRAWS, AND NOTHING ELSE — the row shape `GET /v2/sessions/live`
 * answers with (issue #459).
 *
 * WHY A NARROWER RECORD RATHER THAN THE WHOLE ONE. That route is the read every
 * cockpit makes on a timer, on every paired host, forever: on the owner's store
 * it was 318 KB and 200 ms for 267 sessions, three times a second between a Mac
 * and a phone, and the engine sat at 70% CPU for hours. A list is not a session;
 * it is a list OF sessions, and the fields below are the ones a row actually
 * renders. Everything no reader of this list reads — the environment, the
 * provider instance, the resume cursor, the runtime and interaction modes,
 * `detached`, the rate-limit and message latches, and the un-settle ledger — is
 * engine bookkeeping that belongs to `GET /v2/sessions/:id`, where a reader who
 * opened one conversation pays for one conversation.
 *
 * `envMode` STAYS, though no rail draws it: the `sessions` toolkit reads this
 * same route out-of-process and reports it on every row it lists, so dropping it
 * would move the cost to a per-session read rather than remove it.
 *
 * IT IS A STRICT SUBSET OF `Session`'S KEYS, deliberately: every full record is
 * assignable to this, so a caller that already had one keeps working and a
 * client's projection (`toSidebarSession`, `InboxStore`) needs no second shape.
 * The narrowing is what the wire drops, never a renaming.
 *
 * `workspace.baseRef` GOES WITH THEM. It is the commit a checkout was cut from —
 * a review surface's question, asked once per session opened, and 40 bytes on
 * every row of every poll otherwise.
 */
export const LiveSessionRow = Session.omit({
  environmentId: true,
  origin: true,
  providerInstanceId: true,
  runtimeMode: true,
  interactionMode: true,
  detached: true,
  resumeCursor: true,
  resumeAfterRateLimit: true,
  agentMessagesBlocked: true,
  paused: true,
  unsettledAssignments: true,
});
export type LiveSessionRow = z.infer<typeof LiveSessionRow>;


/**
 * HOURS, NOT DAYS — the window moved to hour granularity when a reader with
 * twenty quiet-but-recent conversations had no number that would take them:
 * a day was the old minimum, and "settle after a few hours" is the ordinary
 * want for a fast-moving dogfooding week. The bounds are the old 1..90 days
 * expressed in the new unit; the default is still three days.
 */
export const MIN_AUTO_SETTLE_HOURS = 1;
export const MAX_AUTO_SETTLE_HOURS = 90 * 24;
export const DEFAULT_AUTO_SETTLE_HOURS = 3 * 24;

/**
 * THE DELEGATION GRACE — how long after a coordinator takes delivery before
 * the engine shelves the conversation that did the work (issue #378).
 *
 * A SETTING OF ITS OWN, NOT THE QUIET WINDOW, and the difference is the whole
 * point: the quiet clock guesses from silence, and three days of it is right
 * for a conversation nobody has touched. This one is measured from a FACT the
 * engine stamped — the result reached the coordinator — so it needs only long
 * enough for a person to notice the answer before the row recedes. An hour.
 *
 * The bounds are the quiet window's, so one number reads the same in both
 * rows of the settings pane; `null` is the same "off" answer, and means the
 * engine settles nothing on its own.
 */
export const DEFAULT_SETTLE_DELEGATED_AFTER_HOURS = 1;

/**
 * HOW THE READER WANTS THEIR LIST BANDED — the POLICY half of settling.
 *
 * The per-session half (`settledOverride`, `snoozedUntil`) is a decision about
 * one conversation; this is a standing rule about all of them, and the two are
 * different kinds of thing. It is here rather than in a browser's local storage
 * for the reason stated on those fields: the same sessions are read from the
 * desktop shell and from a browser tab, and a window that differed between them
 * would put the same row in two different bands on one machine. Theme can
 * differ per window because it is about the window. This is about the work.
 *
 * `null` TURNS THE CLOCK OFF — nothing settles by neglect, only by decision.
 * Distinct from a very large number, and the reason this is nullable rather
 * than a number with a sentinel: "never" is an answer, not a duration.
 *
 * ONE FIELD, AND DELIBERATELY NOT A SETTINGS BAG. An engine document called
 * `preferences` invites everything anyone ever wants to remember; this one is
 * named for the surface it governs, and a second field belongs here only if it
 * also decides what the inbox shows.
 */
export const InboxPolicy = z.object({
  autoSettleAfterHours: z.number().int().min(MIN_AUTO_SETTLE_HOURS).max(MAX_AUTO_SETTLE_HOURS).nullable(),
  /**
   * THE SECOND FIELD, AND IT EARNS THE PLACE THE COMMENT ABOVE DEMANDS: it
   * decides what the inbox shows, for the same list, on the same machine.
   *
   * `.default` RATHER THAN REQUIRED, so a policy document written before this
   * existed still parses. A required field would fail the schema on every
   * stored file, and `getInboxPolicy` answers a failed parse with the whole
   * default — which would silently throw away the window somebody chose.
   */
  settleDelegatedAfterHours: z
    .number()
    .int()
    .min(MIN_AUTO_SETTLE_HOURS)
    .max(MAX_AUTO_SETTLE_HOURS)
    .nullable()
    .default(DEFAULT_SETTLE_DELEGATED_AFTER_HOURS),
});
export type InboxPolicy = z.infer<typeof InboxPolicy>;

export const DEFAULT_INBOX_POLICY: InboxPolicy = {
  autoSettleAfterHours: DEFAULT_AUTO_SETTLE_HOURS,
  settleDelegatedAfterHours: DEFAULT_SETTLE_DELEGATED_AFTER_HOURS,
};

/**
 * WHETHER TELAR MAY TELL AN AGENT WHERE IT IS — the two things the engine
 * authors and puts in front of a provider, each with its own switch.
 *
 * ITS OWN DOCUMENT, ON `InboxPolicy`'s OWN INSTRUCTION: a field belongs there
 * only if it decides what the inbox shows, and neither of these decides
 * anything about a list. Same environment scope, and for the sharper version of
 * the reason stated there — this decides what every session on the machine is
 * told, so a per-browser copy would mean one engine injecting a paragraph some
 * of its clients had turned off.
 *
 * BOTH DEFAULT ON. The orientation exists because its absence was a bug, not a
 * feature somebody opts into; the switches exist because a person is entitled
 * to refuse text Telar wrote into their agent's context, and refusing must be
 * one click rather than a config file.
 *
 * WHAT IS NOT COVERED BY IT: the per-surface briefings (`BROWSER_BRIEFING`,
 * `RUN_BRIEFING`). Those say how to drive a capability the session actually
 * has — a tool contract — rather than what the app around it is called, and
 * turning off orientation must not silently break the browser.
 */
export const AgentOrientation = z.object({
  /** The paragraph, injected once per turn through each driver's existing
   *  briefing seam. See `apps/engine/src/orientation.ts`. */
  preamble: z.boolean(),
  /** The `telar` skill, written into each provider's skills directory. Off
   *  removes the file rather than merely stopping it being refreshed. */
  skill: z.boolean(),
});
export type AgentOrientation = z.infer<typeof AgentOrientation>;

export const DEFAULT_AGENT_ORIENTATION: AgentOrientation = { preamble: true, skill: true };

/**
 * WHAT A SESSION IS CREATED WITH WHEN NOBODY SAID — the standing answer to a
 * question the composer otherwise asks on every new conversation.
 *
 * A SEPARATE DOCUMENT FROM `InboxPolicy`, on that schema's own instruction: a
 * field belongs there only if it decides what the inbox shows, and this decides
 * nothing about the list — it decides what gets built when a session starts.
 * Same environment scope, same reason as both policies above: one engine read
 * from the desktop shell and a browser tab must not disagree about what "new
 * session" means.
 *
 * A DEFAULT, NOT A LOCK. Every caller may still say `envMode` outright and get
 * exactly that; this only answers for the ones that don't.
 */
export const SessionDefaults = z.object({
  /**
   * `worktree` gives every new session its own checkout, so two of them can
   * edit the same repo without colliding — the reason to make it the standing
   * choice rather than picking it by hand each time.
   */
  envMode: EnvMode,
});
export type SessionDefaults = z.infer<typeof SessionDefaults>;

/** `local` — what the engine did before this document existed, so an install
 *  that never opens the settings page behaves exactly as it always has. */
export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = { envMode: "local" };

/** Generous: a rail with a thousand project groups has other problems. The cap
 *  exists so a runaway client cannot grow this document without bound. */
export const MAX_SIDEBAR_PROJECT_ORDER = 1000;

/** Per group, and for the pinned band — the same "a runaway client cannot grow
 *  this document" cap as the project order, applied one list at a time. */
export const MAX_SIDEBAR_SESSION_ORDER = 1000;

/**
 * WHERE EACH PROJECT GROUP SITS IN THE RAIL — the arrangement, kept apart from
 * the list it arranges.
 *
 * The rail used to order project groups by their newest conversation, so
 * starting one hoisted its project to the top and every other group shifted
 * under the pointer. A group's place is now a decision: the reader drags it
 * there, and it stays there. `projectOrder` is that decision, top to bottom,
 * as host-qualified group keys (`lib/session-groups.ts`'s `projectGroupKey`:
 * the bare project id for this Mac's projects, `hostId:projectId` for a paired
 * Mac's). A group the list does not name falls in after the named ones, so a
 * newly registered project appears at the bottom rather than in the middle of
 * an arrangement somebody made.
 *
 * ON THE ENGINE, NOT IN A BROWSER, for the reason `InboxPolicy` gives: the same
 * rail is read from the desktop shell, a browser tab and a paired phone, and an
 * arrangement that differed between them would be one you had to redo per
 * window. The keys are the READING cockpit's — a remote host's id is minted by
 * the cockpit that paired it — so this is the arrangement of THIS Mac's rail,
 * which is the only rail that can draw those groups.
 *
 * Absent keys are kept, not pruned: a paired Mac that is away for the afternoon
 * keeps its slot for when it answers again.
 *
 * AND THE ROWS INSIDE, on the same terms. `sessionOrder` is one list per project
 * group, keyed by the same group key `projectOrder` uses; `pinnedOrder` is the
 * pinned band, which is one list because it is one band. The values are the
 * rail's own session keys (`lib/session-list.ts`'s `sessionKey`: the bare id
 * here, `hostId:id` for a paired Mac's row) — a row the stored list does not
 * name falls in after the named ones in the recency order the rail already had,
 * so a conversation started this minute appears where it always did rather than
 * in the middle of an arrangement somebody made.
 *
 * BOTH ARE OPTIONAL ON THE WIRE and default to empty, so a document written
 * before they existed parses as "nobody has arranged any rows" rather than
 * failing and costing the project arrangement stored beside them.
 */
export const SidebarLayout = z.object({
  projectOrder: z.array(z.string().min(1).max(200)).max(MAX_SIDEBAR_PROJECT_ORDER),
  sessionOrder: z
    .record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(MAX_SIDEBAR_SESSION_ORDER))
    .default({}),
  pinnedOrder: z.array(z.string().min(1).max(200)).max(MAX_SIDEBAR_SESSION_ORDER).default([]),
});
export type SidebarLayout = z.infer<typeof SidebarLayout>;

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { projectOrder: [], sessionOrder: {}, pinnedOrder: [] };

/**
 * COMPUTER USE, MEASURED — the settings page's permission readout.
 *
 * Three facts with three different fixes, which is why they are not one enum:
 * the Codex plugin being absent is an install task, the Sky host app being
 * down is one button, and the Automation grant is a macOS decision keyed on a
 * responsible process the engine cannot reliably name from the inside. The
 * `permission` answer comes from ONE REAL read-only call — which is also the
 * granting flow, because an undecided grant makes macOS raise its own prompt.
 */
export const ComputerUsePermission = z.enum(["granted", "denied", "host-not-running", "unknown"]);
export type ComputerUsePermission = z.infer<typeof ComputerUsePermission>;

/** Which engine is supplying the desktop: `cua` is Telar's own open-source
 *  driver (trycua/cua, MIT); `sky` is Codex's proprietary bundled client, the
 *  fallback. The pane names it so the reader knows what holds the grants. */
export const ComputerUseBackend = z.enum(["cua", "sky"]);
export type ComputerUseBackend = z.infer<typeof ComputerUseBackend>;

/**
 * WHOSE SESSIONS TELAR'S OWN COMPUTER USE IS FOR — Claude and OpenCode.
 *
 * NOT CODEX, and that is the whole of the rule. Codex ships its own
 * computer-use provider, so a Codex thread already has a desktop; injecting
 * Telar's would hand that model a second one under a second name, which is the
 * failure the driver used to work around by switching Codex's native feature
 * OFF. Withholding is the simpler and more honest answer: each provider drives
 * the desktop it came with.
 *
 * ONE FACT, ONE PLACE. The engine folds this into a claim (`withComputerUse`)
 * and the Agent tools pane badges its Computer use row from it, so the pane
 * cannot promise a provider the claim withholds it from — the drift #368 was
 * filed about. A fourth provider is one entry here.
 */
export const COMPUTER_USE_DRIVERS: readonly ProviderDriverKind[] = ["claude", "opencode"];

/** Whether Telar supplies this provider's desktop. See `COMPUTER_USE_DRIVERS`. */
export function driverTakesComputerUse(driver: ProviderDriverKind): boolean {
  return COMPUTER_USE_DRIVERS.includes(driver);
}

export const ComputerUseStatus = z.object({
  installed: z.boolean(),
  hostRunning: z.boolean(),
  /** Absent when not installed. */
  backend: ComputerUseBackend.optional(),
  /** Absent when not installed: there is nothing to measure. */
  permission: ComputerUsePermission.optional(),
  /** The backend's own words, when there were any. */
  message: z.string().optional(),
});
export type ComputerUseStatus = z.infer<typeof ComputerUseStatus>;

/**
 * WHO WRITES THE WORDS THE HUMAN DIDN'T — t3 code's TextGeneration idea, on
 * Telar's shapes. A session's title starts as the first message truncated, and
 * its worktree branch is a slug of that truncation; both are placeholders a
 * small model can do better than. This policy says whether it gets to, and
 * through which harness.
 *
 * A DRIVER, NOT AN INSTANCE. Generation runs as the driver's BUILT-IN slot: it
 * is a background nicety, and pointing it at a custom instance would let a
 * settings page quietly spend somebody's metered account on titles. The model
 * is optional because "the harness's own default" is a fine answer — the
 * engine only pins a cheaper one where it knows the alias (`haiku`).
 *
 * ONE POLICY FOR THE ENVIRONMENT, like `InboxPolicy` above and for the same
 * reason: the same sessions are read from the desktop shell and a browser tab,
 * and a title that regenerates from one window but not the other would look
 * like a sync bug, not a preference.
 */
export const TextGenPolicy = z.object({
  /** Whether a session's first turn also asks a small model for a real title. */
  titles: z.boolean(),
  /** Whether a generated title also renames the engine-cut `telar/…` branch.
   *  Never touches a branch a human named — those live outside `telar/`. */
  renameBranches: z.boolean(),
  driver: ProviderDriverKind,
  /** Model id or alias for the generating call; absent = the driver's default. */
  model: z.string().min(1).max(120).optional(),
});
export type TextGenPolicy = z.infer<typeof TextGenPolicy>;

export const DEFAULT_TEXT_GEN_POLICY: TextGenPolicy = {
  titles: true,
  renameBranches: true,
  driver: "claude",
  // The alias, not a wire id: it keeps meaning "the current cheap model" as
  // the provider moves it, exactly why `ProviderModel.resolves` exists.
  model: "haiku",
};

/**
 * The live process. Not user-owned state — the engine's handle on something it
 * supervises, and safe to lose: everything durable is on the session and the
 * journal.
 */
export const RuntimeState = z.enum(["starting", "ready", "running", "waiting", "stopped", "error"]);
export type RuntimeState = z.infer<typeof RuntimeState>;

/** `waiting` is the one that matters for detached runs: it means an open
 *  request is parked and no further work will happen until someone answers. */
export const Runtime = z.object({
  sessionId: Id,
  state: RuntimeState,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  startedAt: Timestamp,
  updatedAt: Timestamp,
  /** Set while `state` is "running". */
  activeRunId: Id.optional(),
  lastError: z.string().min(1).optional(),
});
export type Runtime = z.infer<typeof Runtime>;

/**
 * Turn lifecycle. THE V1 STATES ARE KEPT VERBATIM, deliberately — they are the
 * best-designed part of protocol v1 and they are what makes a detached turn
 * safe to recover after a crash:
 *
 *   queued → claimed → running → completed | failed | stopped
 *                              ↘ ambiguous → discarded | (replayed)
 *
 * `ambiguous` is the state a turn lands in when the engine cannot tell whether
 * a provider invocation actually happened — the crash-mid-call case. It is NOT
 * auto-retried, because replaying a turn that already ran can duplicate side
 * effects; a human chooses, and `discarded` records that they chose not to.
 * Losing this would make crash recovery guesswork.
 */
export const TurnState = z.enum([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "stopped",
  "ambiguous",
  "discarded",
  /**
   * SEND NOW, IN TWO STATES — promoted into the RUNNING turn, and delivered.
   *
   * Two rather than one because the sweep on turn settlement must tell them
   * apart: a `steering` turn's message has NOT reached the provider and goes
   * back to `queued` (the message must never vanish), where a `steered` turn
   * is terminal — its words are part of the run named in `steer.intoRunId`.
   */
  "steering",
  "steered",
]);
export type TurnState = z.infer<typeof TurnState>;

/** Why a turn stopped short of completing. */
export const TurnFailureCode = z.enum([
  "provider_unavailable",
  "driver_failed",
  "cancelled",
  "budget_exhausted",
  "internal_error",
  /**
   * THE ENGINE WAS SHUT DOWN WHILE THIS TURN WAS RUNNING — and it said so on
   * the way out, rather than leaving the turn `running` for the next boot to
   * find and call `ambiguous`.
   *
   * A `failed` STATE rather than a state of its own, and that is the whole
   * economy of the thing: every client already treats `failed` as terminal and
   * non-blocking, and the cockpit already offers a continuation on one. A new
   * state would have meant teaching the web app, the iOS app and every
   * projection what it means, with each of them defaulting to "unknown, so
   * block" until they were.
   *
   * IT DOES NOT MEAN NOTHING HAPPENED. We know the turn was interrupted; we do
   * NOT know what it had already done — a push, an `rm`, an outbound call are
   * all committed to the world before any abort reaches us. So the copy on
   * this failure names the interruption and claims nothing about its effects,
   * and `interrupted` must never be read as "safe to replay".
   */
  "interrupted",
  /**
   * THE ACCOUNT'S USAGE LIMIT WAS REACHED, AND THE PROVIDER SAID WHEN IT LIFTS.
   *
   * Distinct from `driver_failed`, which is what this used to be, because the
   * two call for opposite things: a driver failure is a fault to look at, and
   * this is a wait to sit out. The engine can resume it unattended (see
   * `Session.resumeAfterRateLimit`), and a person reading the row wants the
   * reset time rather than a sentence of provider text.
   *
   * ONLY WHEN `resumeAt` IS KNOWN. A limit reported without a reset time is not
   * this code — nothing could be scheduled from it — so it stays `driver_failed`
   * and reads as the ordinary failure it is.
   *
   * IT CLAIMS NOTHING ABOUT WHAT THE TURN HAD ALREADY DONE. Like `interrupted`,
   * whatever ran is in the turn's items; the limit stopped it where it stood,
   * and resuming continues the provider session rather than replaying it.
   */
  "rate_limited",
]);
export type TurnFailureCode = z.infer<typeof TurnFailureCode>;

/**
 * WHY A TURN FAILED — the code, the sentence, and for `rate_limited` the facts
 * that make it resumable.
 *
 * A NAMED SCHEMA rather than a fourth inline `{ code, message }`: the worker's
 * report, the store's record, the `turn.failed` event and `Turn.failure` all
 * carry the same thing, and they were four copies that had to be edited in step.
 */
export const TurnFailure = z.object({
  code: TurnFailureCode,
  message: z.string(),
  /**
   * `rate_limited`: when the limit lifts, in MILLISECONDS — the engine's own
   * `Timestamp`, like every other time in this contract.
   *
   * THE PROVIDER REPORTS SECONDS. The SDK's `rate_limit_info.resetsAt` is unix
   * seconds, and the `provider_wait` row keeps it in seconds (`resetsAt` on
   * `ProviderWaitDetail`) because that is what the provider said. The driver
   * converts exactly once, here, where the number stops being a quotation and
   * becomes a time the engine schedules against — a sweep comparing seconds
   * against `Date.now()` would wait fifty years and look like a hang.
   */
  resumeAt: Timestamp.optional(),
  /** `rate_limited`: which limit, so a row can say "five hour" rather than "a
   *  limit". Narrowed to the closed set — see `RateLimitType`. */
  limitType: RateLimitType.optional(),
  /**
   * THE SWEEP HAS DEALT WITH THIS ONE — and that is all this says.
   *
   * It exists to bound `queueConcernsAWorker`: a failed `rate_limited` turn
   * keeps its session in the live-queue index so the sweep can find it once
   * `resumeAt` passes, and with no stamp saying "looked at", a session whose
   * setting is OFF would sit in that index for the life of the daemon being
   * re-examined on every claim. Stamped whether the sweep requeued the turn or
   * left it failed, so it means "decided", never "resumed".
   */
  resumeDecidedAt: Timestamp.optional(),
});
export type TurnFailure = z.infer<typeof TurnFailure>;

/**
 * The subset a WORKER may report — not every code above.
 *
 * `cancelled` and `internal_error` are the engine's own to write; a worker
 * claiming either would be describing a decision it did not make. The fail
 * route enforces this list and the store's `TURN_FAILURE_CODES` repeats it.
 *
 * NAMED, rather than spelled out at each of those places, because adding
 * `interrupted` found THREE hand-maintained copies of it — the route, the
 * store, and the client's `failTurn` signature — and the first two accepted the
 * new code while the third still rejected it at compile time. One definition
 * means the next code added is added once.
 */
export const WorkerTurnFailureCode = TurnFailureCode.exclude(["cancelled", "internal_error"]);
export type WorkerTurnFailureCode = z.infer<typeof WorkerTurnFailureCode>;

/** What a WORKER may send to the fail route: the codes above, plus the two
 *  `rate_limited` facts. `resumeDecidedAt` is absent on purpose — the sweep's
 *  own stamp is the engine's to write, never a worker's to claim. */
export const WorkerTurnFailure = TurnFailure.omit({ resumeDecidedAt: true }).extend({ code: WorkerTurnFailureCode });
export type WorkerTurnFailure = z.infer<typeof WorkerTurnFailure>;

/** A worker's exclusive lease on a queued turn. The token is what stops two
 *  workers running the same turn after a partition. */
export const TurnClaim = z.object({
  workerId: Id,
  token: Id,
  at: Timestamp,
  /**
   * THE QUEUE'S `nextSequence` AT THE INSTANT OF THE CLAIM — the boundary
   * between "written while this session looked idle" and "written into this
   * turn". Every turn submitted after this claim has `sequence >= this`, and
   * `markRunning` steers exactly those into the turn as it starts, closing the
   * window in which a claimed-but-not-yet-running turn could take no message.
   *
   * A SEQUENCE, NOT A TIMESTAMP. Submission order is what the question is
   * actually about, and `nextSequence` already answers it exactly: two
   * messages in one millisecond are ordered, and a clock that steps backwards
   * cannot reorder them. A timestamp comparison got both wrong.
   *
   * Optional because claims written before this field existed do not have it;
   * absent means promote nothing, which is the behaviour those claims were
   * written under.
   */
  sequence: z.number().int().nonnegative().optional(),
});
export type TurnClaim = z.infer<typeof TurnClaim>;

/**
 * WHAT A SUBSCRIBED SESSION MAY BE WOKEN FOR.
 *
 * The three terminal turn transitions and a request parking. NO `idle`: idle
 * is the absence of a live turn, and the terminal kinds already say when it
 * begins. NO `turn_started`: a subscriber that wanted to know a turn began
 * would be polling with extra steps, and `sessions_send` already tells the
 * sender its message was accepted.
 */
export const WakeKind = z.enum(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]);
export type WakeKind = z.infer<typeof WakeKind>;

/** Why an `origin: "session"` turn was queued — what happened, and where. */
export const WakeReason = z.object({
  kind: WakeKind,
  /** The session that did the thing. */
  sessionId: Id,
  /** Its turn, for the three turn kinds — and for `request_opened`, the turn
   *  the request belongs to. */
  runId: Id.optional(),
  requestId: Id.optional(),
});
export type WakeReason = z.infer<typeof WakeReason>;

/**
 * ONE SESSION ASKING TO BE WOKEN BY ANOTHER.
 *
 * Recorded HERE and on neither session: a subscription is an explicit,
 * revocable, one-directional wish — it is not a parent/child link, and
 * neither session's own record mentions the other. Engine-wide file
 * (`subscriptions.json`), because the pair spans sessions.
 *
 * NO `expiresAt`: nothing reads one. A subscriber that is archived or deleted
 * takes its subscriptions with it, and `once` covers "just the next time".
 */
export const Subscription = z.object({
  id: Id,
  subscriberSessionId: Id,
  targetSessionId: Id,
  events: z.array(WakeKind).min(1),
  /** Removed after it fires once. */
  once: z.boolean().optional(),
  createdAt: Timestamp,
});
export type Subscription = z.infer<typeof Subscription>;

export const AgentMessageIntent = z.enum(["task", "report", "result", "blocker"]);
export type AgentMessageIntent = z.infer<typeof AgentMessageIntent>;

export const Turn = z.object({
  /**
   * CLIENT-SUPPLIED IDEMPOTENCY KEY, kept from v1. Submitting the same runId
   * twice returns the first turn rather than queueing a second — which is what
   * makes a retry after a dropped response safe.
   */
  runId: Id,
  sessionId: Id,
  sequence: z.number().int().nonnegative(),
  state: TurnState,

  /** What the human asked for. */
  input: z.string(),
  /**
   * WHAT KIND OF TURN THIS IS. Absent means a message — the human said
   * something. `compact` is the context-compaction gesture: the cockpit's
   * button, not a sentence, and the transcript renders it as a system row
   * rather than a bubble. It was submitted as the literal text "/compact"
   * before, so the history read as the human typing a slash command — three
   * times in a row, on one measured session, because nothing refused a
   * second one while the first was in flight.
   */
  kind: z.enum(["message", "compact"]).optional(),
  /**
   * WHO STARTED THIS TURN. Absent means a human (or another session, through
   * `sessions_send`) sent a message. `provider` is a turn the CLI started ON
   * ITS OWN — a background task or monitor fired between engine turns, the
   * CLI injected its notification as a user message and ran the model on it.
   * Such a turn has no `input` a human typed; `input` carries the provider's
   * own notification text, and `providerReason` names the task that woke it.
   * Transcripts draw it as a wake-up rather than a bubble, and a message a
   * human sends while one runs is steered into it rather than queued behind
   * it.
   *
   * `session` is a turn ANOTHER SESSION caused, one of two ways:
   *   - a WAKE the engine queued because a session this one had subscribed
   *     to did something — `input` is the engine's own text (it begins with
   *     `[wake]`) and `wakeReason` names the source. Drawn as a wake-up row.
   *   - a DIRECT MESSAGE an agent sent through `sessions_send` — `input` is
   *     the agent's own words and `sender` names it. Drawn as an agent
   *     bubble, never as the person's: the words are a peer's report, and
   *     nothing about them is a human decision.
   * Exactly one of `wakeReason` / `sender` is present on such a turn.
   */
  origin: z.enum(["user", "provider", "session"]).optional(),
  /**
   * WHO SENT A DIRECT `origin: "session"` MESSAGE. Stamped by the engine from
   * proof the worker supplies (the claim token of the turn doing the sending),
   * never from a tool argument — a model cannot claim to be a session it is
   * not. `sessionId` is absent when the sender is an agent OUTSIDE any session:
   * the user's own chat client on the sessions MCP socket.
   */
  sender: z.object({ sessionId: Id.optional() }).optional(),
  agentIntent: AgentMessageIntent.optional(),
  agentDelivery: z.enum(["passive", "wake"]).optional(),
  agentSourceRunId: Id.optional(),
  /**
   * WHAT THE MODEL IS HANDED INSTEAD OF `input`, on an agent-sent turn.
   *
   * A short notice in the wake's register — who sent it, which run holds it,
   * how many characters it is, its opening line (its opening PARAGRAPH for a
   * task or a blocker), and the `sessions_read` call that fetches the rest.
   * `input` still holds the message exactly as sent; nothing is abridged on
   * disk. Only the recipient's CONTEXT stopped paying for a peer's whole
   * report on arrival.
   *
   * MINTED BY THE ENGINE AT SUBMIT TIME (`submitAgentTurn` → `agentNotice()`)
   * and stored here, so the provider prompt, the desktop transcript row and a
   * phone all read one string rather than each deriving their own.
   *
   * ABSENT ON EVERY AGENT TURN STORED BEFORE THIS EXISTED, and on wakes and
   * human messages, which were never the body-sized problem. A reader that
   * finds it missing falls back to `input` — see `framedTurnInput`.
   */
  agentNotice: z.string().max(4_000).optional(),
  /**
   * WHAT THE SENDER SAID THIS TASK COVERS, on the task turn itself.
   *
   * DELIBERATELY NOT A SECOND QUEUE. An assignment is DERIVED from the task
   * turns a session holds (`activeAssignments`), because the turn is already
   * the durable record of "this work was handed over" — a parallel list would
   * be a second thing to keep in step and a second thing to get wrong.
   *
   * Scope is descriptive. It confers NO authority: a task naming a file does
   * not grant permission to write it, and every existing approval still applies.
   */
  assignmentScope: z.string().max(2_000).optional(),
  /**
   * The human chose "continue independently". The assignment stops being
   * PRESENTED as active; the turn, its outcome and `startedFrom` all remain.
   * Detaching stops nothing that is running.
   */
  assignmentDetachedAt: Timestamp.optional(),
  providerReason: z
    .object({
      kind: z.enum(["task_notification", "unknown"]),
      /** The row (`task_<tool_use_id>`) whose ending woke the model, when known. */
      taskId: Id.optional(),
    })
    .optional(),
  /** For an `origin: "session"` turn: what happened, and where. */
  wakeReason: WakeReason.optional(),
  /**
   * Files sent WITH this message.
   *
   * ON THE TURN RATHER THAN THE SESSION, because that is what they are: an
   * attachment answers "look at this" about one message, and a session-level
   * list would have no answer to which message it belonged to. Stored resolved
   * (name, media type, path) rather than as ids, so replaying a turn from the
   * queue does not require a second lookup that could have gone stale.
   */
  attachments: z.array(TurnAttachment).optional(),
  /** Model actually used, which may differ from the session default if the
   *  turn overrode it or the provider rerouted. The instance is always the
   *  session's — see `TurnModelSelection`. */
  model: ModelSelection.optional(),
  interactionMode: InteractionMode.optional(),

  acceptedAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Timestamp.optional(),
  completedAt: Timestamp.optional(),

  claim: TurnClaim.optional(),
  usage: UsageSnapshot.optional(),

  /** The assistant's final text. The full timeline is in the journal; this is
   *  the summary a list view renders without replaying events. */
  resultText: z.string().optional(),
  failure: TurnFailure.optional(),
  /**
   * THIS TURN CAME BACK BY ITSELF after a usage limit lifted — when the sweep
   * requeued it.
   *
   * SEPARATE FROM `failure`, WHICH IS DELIBERATELY KEPT. A requeued turn is
   * `queued` again, so it is no longer failed; but a person scrolling back
   * should still see that the session sat out a limit rather than finding an
   * unexplained gap. The failure records what happened, this records that the
   * engine acted on it, and the transcript draws one line from the pair.
   *
   * Absent on every turn that never hit a limit, and on one a human resumed
   * with the button — that is a person's own action, already visible as the
   * press, and claiming the engine did it would be a small lie in the record.
   */
  resumedAfterRateLimit: Timestamp.optional(),
  /**
   * WHY A `stopped` TURN STOPPED — and how much is known about what it had
   * already done.
   *
   * `user` and `agent` are somebody pressing Stop: the work ended where it
   * stood. `engine_restart` and `worker_unavailable` are the process going
   * away underneath it, which is the same ending told honestly — what the turn
   * had already done is in its items, and whether it finished anything
   * OUTSIDE this engine (a file written, a command that reached a server) is
   * unknown and must never be reported as either rolled back or completed.
   *
   * This is what replaced `ambiguous`. That state asked the person to decide
   * something the engine could not tell them enough to decide, and held the
   * session's dispatch until they did; the honest half of it — "we do not know
   * whether it finished" — is a sentence on a terminal row, not a gate.
   */
  stopReason: z.enum(["user", "agent", "engine_restart", "worker_unavailable"]).optional(),

  /** Provider continuity produced BY this turn, and the input to the next. */
  providerSessionId: z.string().min(1).optional(),

  /** Present once this queued turn was promoted into a running one — see the
   *  `steering`/`steered` states above. `deliveredAt` lands with `steered`. */
  steer: z
    .object({
      intoRunId: Id,
      requestedAt: Timestamp,
      deliveredAt: Timestamp.optional(),
    })
    .optional(),

  /**
   * QUEUED, BUT WRITTEN FOR A CONVERSATION THAT NO LONGER EXISTS.
   *
   * Set by recovery on messages that were already waiting when a turn was lost.
   * They keep their place and their order and are never dropped — but no worker
   * may claim one until a human has looked at it, because it was composed
   * against a state of the world that the interrupted turn took with it. "Also
   * update the docs" means something different when you no longer know whether
   * the docs were updated.
   *
   * A PROPERTY OF THE TURN, NOT OF THE SESSION, and that distinction is the
   * whole reason this field exists. The hold was first derived from "this
   * session has an ambiguous turn", which meant resolving the ambiguity — the
   * very act of pressing Continue — released the entire pre-crash backlog in
   * the same instant, unreviewed. Marking the turns themselves lets the
   * ambiguity be settled and the backlog stay held, and lets a FRESH message
   * typed after Continue run immediately, which is the point of continuing.
   *
   * Cleared by `releaseHeldTurn` (run it) or ended by `stopTurn` (drop it).
   *
   * `session_paused` is the third reason: the message arrived, or was still
   * waiting, while a human had the session paused (`Session.paused`). Lifted
   * for the whole backlog by `resumeSession`, or one message at a time by
   * `releaseHeldTurn` — which does NOT un-pause the session.
   */
  held: z
    .object({
      at: Timestamp,
      reason: z.enum(["engine_restart", "worker_unavailable", "session_paused"]),
    })
    .optional(),
});
export type Turn = z.infer<typeof Turn>;

/**
 * A project's git state, as the engine last read it.
 *
 * READ-ONLY BY CONSTRUCTION. It exists so a client can say WHERE work lands —
 * the composer's foot names the project and branch the next message will act on
 * — and nothing here implies a mutation. A project that is not a repository
 * reports `repository: false` rather than failing, because `envMode: "local"`
 * supports exactly that case on purpose.
 */
export const GitWorktreeEntry = z.object({
  path: z.string(),
  basename: z.string(),
  /** Absent on a detached checkout, which is a real state and not a name. */
  branch: z.string().optional(),
  isMainCheckout: z.boolean(),
});
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntry>;

/**
 * ONE FILE, AS GIT SEES IT — which is a different witness from the journal.
 *
 * `Item`'s `file_change` says what the agent REPORTED writing, with the patch
 * its own tool produced. This says what is actually different on disk. They
 * disagree constantly and usefully: a `bun install` touches a lockfile no
 * transcript mentions, a build writes artefacts, and a file the agent edited
 * twice can end up byte-identical to where it started. The cockpit's review
 * surface exists to show exactly that disagreement.
 */
export const GitChangeStatus = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);
export type GitChangeStatus = z.infer<typeof GitChangeStatus>;

export const GitFileChange = z.object({
  path: z.string().min(1),
  status: GitChangeStatus,
  renamedFrom: z.string().min(1).optional(),
  /** Absent rather than zero for a binary file and for an untracked one — git
   *  counts neither, and a confident `+0` would be a fabrication. */
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

/** A commit the session itself made. Agents commit; a review that showed only
 *  the working tree would report a finished session as having done nothing. */
export const GitCommitEntry = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  subject: z.string(),
  /** Author date, epoch milliseconds — the same unit as every other timestamp
   *  in this contract, converted at the seam rather than by three clients. */
  at: Timestamp,
  author: z.string(),
});
export type GitCommitEntry = z.infer<typeof GitCommitEntry>;

/**
 * WHAT THIS SESSION HAS DONE TO THE REPOSITORY, committed and uncommitted
 * together, measured from where it started.
 *
 * The frozen cockpit answered two narrower questions and neither was the one a
 * reviewer asks. `git status` forgets a change the moment the agent commits it;
 * a branch comparison forgets everything still uncommitted. `base…worktree`
 * covers both, and it is the only framing under which "is this session's work
 * good" has a single answer.
 *
 * SCOPED TO THE SESSION'S OWN CHECKOUT. A worktree session has a branch and a
 * working tree of its own, so running this against the project root would
 * describe somebody else's changes — which is what the donor's pane did.
 */
export const SessionDiff = z.object({
  repository: z.boolean(),
  /** The session's own checkout: its worktree, or the project root. */
  workspacePath: z.string().min(1),
  branch: z.string().optional(),
  /**
   * Absent means the session has no recorded base and this diff is against
   * HEAD instead — so committed work is NOT included and the surface has to say
   * so. Present is the full answer.
   */
  base: z.string().min(1).optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  files: z.array(GitFileChange),
  commits: z.array(GitCommitEntry),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  /** The file list is capped. Reported so a truncated review cannot read as a
   *  complete one. */
  truncated: z.boolean(),
});
export type SessionDiff = z.infer<typeof SessionDiff>;

/**
 * One ref a worktree session could be cut from. `remote` names come qualified
 * (`origin/main`) because that is both what a human recognises and what
 * `git rev-parse` resolves — the picker forwards the name verbatim as
 * `createSession.baseRef`.
 */
export const GitRefEntry = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  /** The checkout's current branch, so a picker can mark it. Local only. */
  head: z.boolean().optional(),
});
export type GitRefEntry = z.infer<typeof GitRefEntry>;

export const GitOverview = z.object({
  repository: z.boolean(),
  branch: z.string().optional(),
  dirtyFiles: z.number().int().nonnegative(),
  /** Both absent when the branch has no upstream — which is NOT zero/zero. */
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  worktrees: z.array(GitWorktreeEntry),
  /**
   * Local and remote-tracking branches, newest commit first, capped — the
   * base-ref picker's menu. Remote entries are whatever the last fetch saw:
   * the engine's git surface stays read-only, so it never fetches to freshen
   * them. Absent (never empty) on a non-repository.
   */
  refs: z.array(GitRefEntry).optional(),
  /**
   * The remote's default branch (`origin/main`), when remote-tracking state
   * exists — what a fresh worktree is cut from unless the person picks
   * otherwise. From `origin/HEAD` where a clone recorded one, else the common
   * names checked against `refs`. Absent means "default to the checkout's
   * HEAD", which is also what absent always meant.
   */
  defaultBase: z.string().min(1).optional(),
});
export type GitOverview = z.infer<typeof GitOverview>;

/**
 * WHAT IS IN A CHECKOUT — the flat list a file tree is built from.
 *
 * FLAT PATHS, NOT A TREE. A nested payload would encode one client's idea of how
 * to group and sort, and every consumer would have to walk it anyway to search.
 * A list of repo-relative paths is the smallest true thing, and the shape is
 * `a/b/c.ts` on every platform because a backslash is a legal character in a
 * POSIX filename and a client cannot tell the two apart afterwards.
 *
 * DIRECTORIES ARE IMPLIED BY THEIR CONTENTS, which means an EMPTY directory does
 * not appear. That is git's own view — it tracks files, not folders — and
 * inventing folder entries the versioning system cannot see would make the tree
 * disagree with `git status` for no gain.
 *
 * `source` IS THE HONEST BIT. In a repository this is git's index plus untracked
 * files, so `.gitignore` decides what a person sees and `node_modules` never
 * appears. In an unversioned directory — which `envMode: "local"` supports on
 * purpose — there is no ignore file to obey, so the engine walks the directory
 * with its own small deny list and says that is what it did.
 */
export const WorkspaceListingSource = z.enum(["git", "walk"]);
export type WorkspaceListingSource = z.infer<typeof WorkspaceListingSource>;

export const WorkspaceListing = z.object({
  /** The checkout these paths are relative to: a session's worktree, or a
   *  project root. Named in full because the next thing a reader does is `cd`. */
  workspacePath: z.string().min(1),
  repository: z.boolean(),
  files: z.array(z.string().min(1)),
  source: WorkspaceListingSource,
  /** The list is capped. Reported so a partial tree cannot read as a whole
   *  repository — a tree that silently stops is worse than one that says it did. */
  truncated: z.boolean(),
  readAt: Timestamp,
});
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

/**
 * WHAT THE PROVIDER CAN BE ASKED TO DO — the composer's `$` and `/` menus.
 *
 * TWO LISTS, NOT ONE TAGGED LIST, because the two are reached by two different
 * keys and inserted in two different ways: a skill is named inside a sentence,
 * a slash command is a line the provider parses. A single array with a `kind`
 * would make every consumer partition it before it could draw anything.
 *
 * `source` IS WHERE THE NAME CAME FROM, and it is contract rather than
 * decoration: it is what lets a reader tell their own `~/.claude/skills` from a
 * plugin's, and what a menu groups by. `provider` means the harness itself
 * reported it (`supportedCommands()`), which is the only source Telar cannot
 * point at a file for.
 *
 * A PROVIDER WITH NO INVENTORY ANSWERS WITH TWO EMPTY LISTS rather than a 404:
 * "this harness exposes none" is a real answer about Codex, and a menu that
 * draws nothing is the correct rendering of it.
 */
export const ProviderSkillSource = z.enum(["user", "project", "plugin", "provider"]);
export type ProviderSkillSource = z.infer<typeof ProviderSkillSource>;

export const ProviderSkill = z.object({
  /** What a person types, WITHOUT the leading slash: `commit`, `vercel:deploy`.
   *  Namespaced exactly as the provider addresses it — any other spelling is a
   *  row that does nothing when it is picked. */
  name: z.string().min(1),
  /** One line about what it does. Empty when neither the front matter nor the
   *  file's first heading said, which is commoner than it should be. */
  description: z.string(),
  source: ProviderSkillSource,
});
export type ProviderSkill = z.infer<typeof ProviderSkill>;

export const ProviderSkills = z.object({
  skills: z.array(ProviderSkill),
  commands: z.array(ProviderSkill),
});
export type ProviderSkills = z.infer<typeof ProviderSkills>;

/**
 * ONE FILE'S TEXT, as it is on disk right now.
 *
 * NOT A PATCH. `sessionFilePatch` answers "what changed"; this answers "what
 * does this file say", which is the question a file tree raises and the diff
 * cannot answer for the majority of files that did not change.
 *
 * BINARY AND TRUNCATED ARE BOTH STATED rather than approximated. A viewer handed
 * the first half of a file with no flag would show a syntax error that is not in
 * the source, and one handed a PNG's bytes as UTF-8 would show line noise.
 */
export const WorkspaceFile = z.object({
  path: z.string().min(1),
  /** Empty for a binary file — there is no text to send, and sending mojibake
   *  would be worse than sending nothing. */
  text: z.string(),
  /** The file's real size, even when the text above was cut short. */
  bytes: z.number().int().nonnegative(),
  /**
   * SHA-256 OF THE WHOLE FILE ON DISK, and the thing that makes editing safe.
   *
   * An editor sends it back with a write and the engine refuses if disk has moved
   * since — which it may well have, because an agent could be writing this file
   * mid-turn while somebody types in the panel. Of the WHOLE file even when
   * `truncated` is set, because a precondition computed over a prefix would
   * authorise a save that discards everything after it.
   */
  sha256: z.string().min(1),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

/**
 * WHY A WRITE WAS REFUSED. Four reasons, because a reader needs four different
 * responses: re-read and re-apply (`conflict`), nothing to save (`binary`), this
 * file is too big for the panel to hold safely (`too_large`), and this endpoint
 * replaces rather than creates (`not_found`).
 */
export const WorkspaceWriteRefusal = z.enum(["not_found", "binary", "too_large", "conflict"]);
export type WorkspaceWriteRefusal = z.infer<typeof WorkspaceWriteRefusal>;

/**
 * The answer to a write.
 *
 * A REFUSAL IS AN ANSWER, NOT AN ERROR — the same shape `commitSessionWork` uses,
 * and for the same reason: "the file changed under you" is a fact about the
 * repository that the surface must render, not an exception it should catch. The
 * current `sha256` rides along so an editor can offer to re-read without a second
 * round trip.
 */
export const WorkspaceWriteResult = z.union([
  z.object({ written: z.literal(true), file: WorkspaceFile }),
  z.object({ written: z.literal(false), refusal: WorkspaceWriteRefusal, sha256: z.string().min(1).optional() }),
]);
export type WorkspaceWriteResult = z.infer<typeof WorkspaceWriteResult>;

/**
 * What ignoring Telar's own files in a repository did.
 *
 * BOTH HALVES ARE REPORTED, because "added nothing" and "did nothing" look the
 * same to a reader and mean the opposite: a repository that already ignores every
 * rule is the success case, and reporting it as an empty result makes the control
 * look broken to anyone who presses it twice.
 *
 * THE RULES ARE THE ENGINE'S, NOT THE CALLER'S, and that is a boundary rather
 * than a convenience. A client that could name the lines to append could append
 * anything to a file inside somebody's repository — this is the only write in the
 * whole contract that touches a file the user did not name.
 */
export const GitignoreResult = z.object({
  /** Rules written just now, in the order they were appended. */
  added: z.array(z.string()),
  /** Rules an existing pattern already covered, so nothing was written for them. */
  present: z.array(z.string()),
  /** Absolute path of the file that was created or appended to. */
  path: z.string().min(1),
  /** True when there was no `.gitignore` and this call created one. Worth its own
   *  field: creating a file in a repository that had none is a bigger thing than
   *  adding two lines to one that did. */
  created: z.boolean(),
});
export type GitignoreResult = z.infer<typeof GitignoreResult>;

/**
 * What UNDOING that write did.
 *
 * A SEPARATE SHAPE RATHER THAN A REUSED ONE. The add reports two lists because
 * "added nothing" and "was already covered" mean opposite things; the undo has no
 * such pair — a rule is either taken out or was never ours to take out — and
 * `present: []` on the way back would be a field with no meaning.
 *
 * AN EMPTY `removed` IS A SUCCESS. The undo runs from a toast, which can arrive
 * after somebody edited the file by hand, and "there was nothing of ours left" is
 * an answer rather than a failure.
 */
export const GitignoreRemoval = z.object({
  /** Rules taken back out, in the order they appeared in the file. */
  removed: z.array(z.string()),
  /** Absolute path of the file that was rewritten, whether or not it changed. */
  path: z.string().min(1),
});
export type GitignoreRemoval = z.infer<typeof GitignoreRemoval>;
