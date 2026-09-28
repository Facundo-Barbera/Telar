import type {
BrowserSnapshot,
ClaudeConversation,
ConversationImportDetail,DataScienceInstallCommand,
DataScienceManager,
DataSciencePackage,DataScienceRequirementsSource,LatexCompileStatus,LatexDiagnostic,LatexToolchain,McpOAuthStatus,
McpServer,
McpServerSpec,TurnAttachment,ProviderDriverKind,
ProviderSkills,
ProviderInstance,
ProviderInstanceEnvVar,
AutoCompact,
ProviderProbe,Session,Turn,WorkspaceFile,
WorkspaceListing,
WorkspaceWriteResult
} from "@telar/engine-client";
import type { ExecResult, KernelState, NotebookRead, TableWindow, VarRow } from "@/lib/ds";
import { request, type Fetcher } from "./transport";

/** The cockpit's own workspace calls: the ones no package domain client covers yet. */
export function workspaceCalls(fetcher: Fetcher) {
  return {
    projectFiles: (projectId: string) =>
      request<{ listing: WorkspaceListing }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/files`),
    sessionFiles: (sessionId: string) =>
      request<{ listing: WorkspaceListing }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/files`),
    /**
     * The provider's own skills and slash commands, for the composer's `$` and
     * `/` menus. Asked when a menu first opens and cached by the caller for the
     * session, the way the path listing is — the engine caches it too, so the
     * cost of asking twice is a round trip rather than a subprocess.
     */
    sessionSkills: (sessionId: string) =>
      request<ProviderSkills>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/skills`),
    claudeConversations: (instanceId?: string) =>
      request<{ conversations: ClaudeConversation[] }>(
        fetcher,
        "GET",
        `/api/claude-conversations${instanceId ? `?${new URLSearchParams({ instanceId }).toString()}` : ""}`,
      ),
    /** Adopt one: fork it, import its history, and point this session's next
     *  turn at the fork. The person's own conversation is not written to. */
    adoptClaudeConversation: (sessionId: string, sourceSessionId: string) =>
      request<{ session: Session; turn: Turn; provenance: ConversationImportDetail }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/adopt`,
        { sourceSessionId },
      ),
    /**
     * The same, one scope wider — what a CANVAS asks, because the session that
     * would answer for itself does not exist yet (#500). `driver` is the
     * canvas's pending choice; absent means the engine's default.
     */
    projectSkills: (projectId: string, driver?: ProviderDriverKind) =>
      request<ProviderSkills>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/skills${driver ? `?${new URLSearchParams({ driver }).toString()}` : ""}`,
      ),
    projectFile: (projectId: string, path: string) =>
      request<{ file: WorkspaceFile }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`,
      ),
    sessionFile: (sessionId: string, path: string) =>
      request<{ file: WorkspaceFile }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
      ),
    writeProjectFile: (projectId: string, path: string, text: string, expectedSha256: string) =>
      request<WorkspaceWriteResult>(
        fetcher,
        "PUT",
        `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`,
        { text, expectedSha256 },
      ),
    writeSessionFile: (sessionId: string, path: string, text: string, expectedSha256: string) =>
      request<WorkspaceWriteResult>(
        fetcher,
        "PUT",
        `/api/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
        { text, expectedSha256 },
      ),
    /**
     * THE SESSION'S KERNEL, NOTEBOOKS AND PLOTS. Every verb is a POST to one
     * `ds/<method>` door on the engine — the same door the agent's toolkit
     * uses — so a cell run from here and one run by `notebook_run_cell` land
     * in the same kernel and write the same file.
     */
    kernel: (sessionId: string) =>
      request<{ state: KernelState; executionCount?: number; modules?: Record<string, boolean>; python?: string; executable?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/kernel`, {}),
    kernelInterrupt: (sessionId: string) => request<object>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/interrupt`, {}),
    kernelRestart: (sessionId: string) => request<object>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/restart`, {}),
    kernelExecute: (sessionId: string, code: string) => request<ExecResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/execute`, { code, producer: "cockpit" }),
    kernelVars: (sessionId: string, limit = 200) => request<VarRow[]>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/vars`, { limit }),
    /** The project's environment as THIS session resolves it (worktree rule), and its packages. */
    sessionPackages: (sessionId: string) =>
      request<{ packages: DataSciencePackage[]; environment: { manager: DataScienceManager; root: string; python: string; command: DataScienceInstallCommand } }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/packages`, {}),
    /** Install / remove in the session's environment. WAITS for the job (the engine's tool does the same). */
    sessionInstall: (sessionId: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }) =>
      request<{ ok: boolean; lines: string[]; error?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/install`, input),
    kernelInspect: (sessionId: string, name: string, depth = 10) =>
      request<Record<string, unknown>>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/inspect`, { name, depth }),
    /**
     * THE SESSION'S LATEX DOOR — the same capability the agent's `latex_*`
     * tools use, so a compile pressed here and one the model ran land on the
     * same job runner and the same last-compile memory.
     */
    latexCompile: (sessionId: string, input: { path?: string; timeoutMs?: number } = {}) =>
      request<{ ok: boolean; path: string; pdfPath?: string; diagnostics: LatexDiagnostic[]; logTail: string[]; error?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/compile`, input),
    latexStatus: (sessionId: string) =>
      request<LatexCompileStatus | { status: "never" }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/status`, {}),
    latexLog: (sessionId: string, input: { tail?: number; around?: number; find?: string } = {}) =>
      request<{ lines: string[] }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/log`, input),
    sessionLatexToolchain: (sessionId: string) =>
      request<{ kind: "tectonic" | "texlive"; binPath: string; engine?: string; version?: string; tlmgr: boolean; mainFile?: string; available: LatexToolchain }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/toolchain`, {}),
    latexClean: (sessionId: string, input: { pdf?: boolean } = {}) =>
      request<{ removed: string[] }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/clean`, input),
    notebook: (sessionId: string, path: string, options: { from?: number; to?: number; withOutputs?: boolean } = {}) =>
      request<NotebookRead>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/read`, { path, ...options }),
    notebookEdit: (
      sessionId: string,
      path: string,
      edit:
        | { kind: "set"; cellId?: string; index?: number; source?: string; cellType?: "code" | "markdown" | "raw" }
        | { kind: "insert"; after?: string | number; source: string; cellType?: "code" | "markdown" | "raw" }
        | { kind: "delete"; cellId?: string; index?: number }
        | { kind: "move"; cellId?: string; index?: number; to: number }
        | { kind: "clearOutputs"; cellId?: string; index?: number }
        | { kind: "create" },
    ) => request<NotebookRead>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/edit`, { path, edit }),
    notebookRun: (sessionId: string, path: string, input: { cellId?: string; all?: boolean; stopOnError?: boolean }) =>
      request<{ results: Array<{ cellId: string; result: ExecResult }>; notebook: NotebookRead }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/run`,
        { path, ...input },
      ),
  };
}

export function integrationCalls(fetcher: Fetcher) {
  return {
    /** The attachment index, optionally by tag. `plot` is what the gallery reads. */
    attachments: (sessionId: string, options: { tag?: string } = {}) =>
      request<{ attachments: TurnAttachment[] }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments${options.tag ? `?tag=${encodeURIComponent(options.tag)}` : ""}`,
      ),
    tagAttachment: (sessionId: string, attachmentId: string, tags: string[]) =>
      request<{ attachment: TurnAttachment }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { tags }),
    /** A window of rows from a CSV, TSV or Parquet file, for the table view. */
    sessionTable: (sessionId: string, path: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }) =>
      request<TableWindow>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/data/table?${new URLSearchParams({
          path,
          offset: String(options.offset),
          limit: String(options.limit),
          ...(options.sort ? { sort: options.sort } : {}),
          ...(options.desc ? { desc: "1" } : {}),
        }).toString()}`,
      ),
    /** What the session's browser is looking at. `screenshot` costs a round trip
     *  through Chromium and `start` would LAUNCH one, so both are opt-in. */
    browserState: (sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}) => {
      const query = new URLSearchParams();
      if (options.screenshot) query.set("screenshot", "1");
      if (options.start) query.set("start", "1");
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<{ browser: BrowserSnapshot }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/browser${suffix}`);
    },
    /** Open a page in the session's browser as the human — the engine's door,
     *  for a client with no native shell (a remote cockpit, a phone). */
    browserOpen: (sessionId: string, url: string) =>
      request<{ browser: BrowserSnapshot }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/browser/open`, { url }),
    /** The MACHINE-WIDE MCP servers — the ones every project sees. A project's
     *  own live under `projectMcpServers`, and the URL is what says which scope
     *  a write lands in. */
    mcpServers: () => request<{ mcpServers: McpServer[] }>(fetcher, "GET", "/api/mcp-servers"),
    /** This project's servers, plus `effective` — the merge its sessions run
     *  with, computed by the engine rather than re-derived here. */
    projectMcpServers: (projectId: string) =>
      request<{ mcpServers: McpServer[]; effective: McpServer[] }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      ),
    saveMcpServer: (input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: McpServerSpec }) => {
      const { projectId, ...rest } = input;
      return request<{ mcpServer: McpServer }>(
        fetcher,
        "PUT",
        projectId ? `/api/projects/${encodeURIComponent(projectId)}/mcp-servers` : "/api/mcp-servers",
        rest,
      );
    },
    mcpOAuthStatus: (projectId?: string) =>
      request<{ statuses: McpOAuthStatus[] }>(
        fetcher,
        "GET",
        projectId ? `/api/mcp/oauth?projectId=${encodeURIComponent(projectId)}` : "/api/mcp/oauth",
      ),
    /** Returns the URL to send the browser to. The redirect origin is decided by
     *  the route from the request, never passed from here — it is the one field
     *  in an OAuth flow that must not be client-chosen. */
    connectMcpOAuth: (serverId: string, projectId?: string) =>
      request<{ authorizationUrl: string }>(fetcher, "POST", "/api/mcp/oauth", {
        serverId,
        ...(projectId ? { projectId } : {}),
      }),
    disconnectMcpOAuth: (serverId: string, projectId?: string) =>
      request<{ removed: boolean }>(fetcher, "POST", "/api/mcp/oauth", {
        action: "disconnect",
        serverId,
        ...(projectId ? { projectId } : {}),
      }),
    providerInstances: (options: { refresh?: boolean } = {}) =>
      request<{ providerInstances: ProviderInstance[]; probes: ProviderProbe[] }>(
        fetcher,
        "GET",
        `/api/provider-instances${options.refresh ? "?refresh=1" : ""}`,
      ),
    saveProviderInstance: (input: {
      id: string;
      driver?: ProviderDriverKind;
      displayName?: string | null;
      accentColor?: string | null;
      /** A whole percentage of the model's window; `null` returns this login to
       *  the cockpit's default. */
      contextNoticePercent?: number | null;
      /** When this login's sessions compact; `null` returns it to the
       *  provider's default. */
      autoCompact?: AutoCompact | null;
      configDir?: string | null;
      binaryPath?: string | null;
      enabled?: boolean;
      env?: ProviderInstanceEnvVar[];
      /** Inherited variables to keep, by name. The engine supplies the values
       *  from its own environment; none crosses this call. */
      carryOverInherited?: string[];
    }) =>
      request<{ providerInstance: ProviderInstance; stoppedInheriting?: string[] }>(
        fetcher,
        "PUT",
        "/api/provider-instances",
        input,
      ),
  };
}
